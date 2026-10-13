import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, ModelRuntime, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { loadSkillEvalConfig } from "../extensions/evals/skill-eval/config.ts";
import { runEvaluation } from "../extensions/evals/skill-eval/runner.ts";

vi.mock("@earendil-works/pi-coding-agent", async importOriginal => {
    const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
    return { ...actual, createAgentSession: vi.fn(actual.createAgentSession) };
});

let root: string;
const realCreateRuntime = ModelRuntime.create.bind(ModelRuntime);
beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "skill-eval-completion-"));
    vi.spyOn(ModelRuntime, "create").mockImplementation(async options => {
        const runtime = await realCreateRuntime({ ...options, modelsStorePath: path.join(root, "catalog.json"), allowModelNetwork: false });
        await runtime.setRuntimeApiKey("anthropic", "fake-test-key");
        return runtime;
    });
});
afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(createAgentSession).mockReset();
    await rm(root, { recursive: true, force: true });
});

async function run(stopReason: AssistantMessage["stopReason"], options: { omitSettlement?: boolean; settlementAborted?: boolean; priorToolResponse?: boolean; timeout?: boolean; cancelBeforePrompt?: boolean } = {}) {
    const project = path.join(root, "project"), agentDir = path.join(root, "agent");
    await mkdir(project); await mkdir(agentDir);
    await writeFile(path.join(project, "value.txt"), "baseline\n");
    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
    const yamlPath = path.join(root, "eval.yaml");
    await writeFile(yamlPath, `version: 1
name: completion
workspace: ./project
agent:
  harness: pi
  model: anthropic/claude-sonnet-4-5
  tools: [read]
limits:
  timeoutSeconds: ${options.timeout ? 1 : 30}
variants:
  first:
    prompt: Inspect the workspace.
  second:
    prompt: This must not start after an unsuccessful first variant.
`);
    const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent");
    let calls = 0;
    vi.mocked(createAgentSession).mockImplementation(async config => {
        const created = await actual.createAgentSession(config);
        created.session.agent.streamFunction = (model, _context, providerOptions) => {
            calls++;
            const stream = createAssistantMessageEventStream();
            const reason = options.priorToolResponse && calls === 1 ? "toolUse" : stopReason;
            const message: AssistantMessage = {
                role: "assistant", api: model.api, provider: model.provider, model: model.id,
                content: reason === "toolUse" ? [
                    { type: "text", text: "Earlier attempt response." },
                    { type: "toolCall", id: "read-value", name: "read", arguments: { path: "value.txt" } },
                ] : reason === "error" || reason === "aborted" ? [] : [{ type: "text", text: "Retained response." }],
                stopReason: reason, errorMessage: reason === "error" ? "Provider rejected the request" : undefined, timestamp: Date.now(),
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            };
            const finish = () => {
                stream.push({ type: "start", partial: message });
                if (reason === "error" || reason === "aborted") stream.push({ type: "error", reason, error: message });
                else if (reason !== "pending") stream.push({ type: "done", reason, message });
                stream.end();
            };
            if (options.timeout && !providerOptions?.signal?.aborted) providerOptions?.signal?.addEventListener("abort", finish, { once: true });
            else finish();
            return stream;
        };
        if (options.omitSettlement || options.settlementAborted) {
            const subscribe = created.session.subscribe.bind(created.session);
            vi.spyOn(created.session, "subscribe").mockImplementation(listener => subscribe(event => {
                if (event.type === "agent_settled" && options.omitSettlement) return;
                listener(event.type === "agent_settled" && options.settlementAborted ? { ...event, aborted: true } : event);
            }));
        }
        return created;
    });
    const controller = new AbortController();
    const result = await runEvaluation(await loadSkillEvalConfig(yamlPath), {
        agentDir, baseDir: path.join(root, "runs"), parentUI: {} as ExtensionUIContext,
        signal: controller.signal,
        onEvent(event) { if (options.cancelBeforePrompt && event.kind === "variant_started") controller.abort(); },
    });
    return { result, calls };
}

describe("skill-eval completion evidence", () => {
    it.each([
        ["error", "agent_error"], ["length", "truncated"], ["aborted", "cancelled"],
    ] as const)("retains %s as %s, not completed or a harness error", async (reason, status) => {
        const { result, calls } = await run(reason);
        expect(result.status).toBe(status);
        const [first, second] = result.storage.record.variants;
        expect(first).toMatchObject({ status, failurePhase: "prompt", error: expect.any(String) });
        expect(second.status).toBe("pending");
        expect(calls).toBe(1);
        const failure = JSON.parse(await readFile(path.join(result.storage.runDir, "failure.json"), "utf8"));
        expect(failure.run.status).toBe(status);
        expect(failure.variants[0].errors[0].message).toBe(first.error);
        const events = await readFile(result.storage.eventsPath, "utf8");
        expect(events).toContain(`"kind":"variant_${status}"`);
        expect(events).not.toContain('"kind":"variant_completed"');
        expect(await readFile(path.join(result.storage.runDir, "report.md"), "utf8")).toContain(status);
        if (reason === "length") expect(await readFile(path.join(result.storage.variantDir("first"), "final-response.md"), "utf8")).toBe("Retained response.");
    }, 15_000);

    it("requires the settlement event rather than only a resolved prompt", async () => {
        const { result } = await run("stop", { omitSettlement: true });
        expect(result.status).toBe("incomplete");
        expect(result.storage.record.variants[0].error).toContain("without settlement evidence");
        expect(result.storage.record.variants[1].status).toBe("pending");
    }, 15_000);

    it("honors settlement abortion over an otherwise successful final response", async () => {
        const { result } = await run("stop", { settlementAborted: true });
        expect(result.status).toBe("cancelled");
        expect(result.storage.record.variants[0].error).toContain("aborted");
    }, 15_000);

    it("does not call earlier text the final response after a textless abort", async () => {
        const { result, calls } = await run("aborted", { priorToolResponse: true });
        expect(result.status).toBe("cancelled");
        expect(calls).toBe(2);
        const variantDir = result.storage.variantDir("first");
        expect(await readFile(path.join(variantDir, "final-response.md"), "utf8")).toBe("");
        expect(await readFile(path.join(variantDir, "transcript.md"), "utf8")).toContain("Earlier attempt response.");
    }, 15_000);

    it("keeps a harness timeout distinct from the resulting SDK abort", async () => {
        const { result, calls } = await run("aborted", { timeout: true });
        expect(result.status).toBe("timed_out");
        expect(result.storage.record.variants[0].status).toBe("timed_out");
        expect(result.storage.record.variants[1].status).toBe("pending");
        expect(calls).toBe(1);
    }, 15_000);

    it("handles parent cancellation before prompting without spending a model call", async () => {
        const { result, calls } = await run("stop", { cancelBeforePrompt: true });
        expect(result.status).toBe("cancelled");
        expect(calls).toBe(0);
        expect(result.storage.record.variants[1].status).toBe("pending");
    }, 15_000);

    it("allows later variants after confirmed normal completion", async () => {
        const { result, calls } = await run("stop");
        expect(result.status).toBe("completed");
        expect(result.storage.record.variants.map(variant => variant.status)).toEqual(["completed", "completed"]);
        expect(calls).toBe(2);
    }, 15_000);
});
