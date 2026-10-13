import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { totalSessionUsage } from "../src/shared/usage-accounting.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.unstubAllEnvs(); });

it("captures real SDK persisted turns without double-counting nested tool usage, then captures late usage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "usage-sdk-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    vi.stubEnv("HOME", root); vi.stubEnv("PI_CODING_AGENT_DIR", root); vi.stubEnv("PI_OFFLINE", "1");
    expect(os.homedir()).toBe(root);
    const usageExtension = (await import("../extensions/usage/index.ts")).default;
    const runtime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: path.join(root, "models.json"),
        modelsStorePath: path.join(root, "model-store.json"), allowModelNetwork: false });
    await runtime.setRuntimeApiKey("anthropic", "fake-in-memory-test-key");
    const model = runtime.getModel("anthropic", "claude-sonnet-4-5")!;
    const billed = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 } };
    let nestedHooks = 0;
    const tools = (pi: ExtensionAPI) => {
        pi.registerTool({ name: "inner", label: "Inner", description: "Synthetic nested model usage", parameters: Type.Object({}),
            async execute() { return { content: [{ type: "text", text: "Synthetic classifier evidence" }], details: {}, usage: billed }; } });
        pi.registerTool({ name: "outer", label: "Outer", description: "Calls the synthetic inner tool", parameters: Type.Object({}),
            async execute(_id, _args, _signal, _update, ctx) {
                const outcome = await ctx.executeTool("inner", {});
                expect(outcome.isError).toBe(false);
                return { content: [{ type: "text", text: "Done" }], details: {} };
            } });
        pi.on("tool_result", event => { if (event.parentToolCallId) nestedHooks++; });
    };
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true,
        noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [usageExtension, tools],
        agentsFilesOverride: () => ({ agentsFiles: [] }), systemPromptOverride: () => "Synthetic offline usage fixture." });
    await loader.reload();
    const manager = SessionManager.create(root, path.join(root, "sessions"));
    const { session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime, resourceLoader: loader,
        sessionManager: manager, settingsManager: settings, noTools: "builtin" });
    cleanup.push(async () => { await session.abort(); await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); });
    const errors: string[] = [];
    await session.bindExtensions({ onError: error => errors.push(error.error) });
    let calls = 0;
    session.agent.streamFunction = () => {
        const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
            timestamp: Date.now(), usage: billed, stopReason: calls++ === 0 ? "toolUse" : "stop", content: [] };
        message.content = message.stopReason === "toolUse" ? [{ type: "toolCall", id: "outer-call", name: "outer", arguments: {} }]
            : [{ type: "text", text: "Synthetic final answer" }];
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message }); stream.end();
        return stream;
    };
    await session.prompt("Use outer.");
    const rows = async () => (await readFile(path.join(root, ".pi/agent/usage/ledger.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(nestedHooks).toBe(1);
    expect((await rows()).map(row => row.kind)).toEqual(["assistant", "tool_result", "assistant"]);
    expect(totalSessionUsage(manager.getEntries())).toMatchObject({ records: 3, totalTokens: 300, totalCost: 0.75 });
    manager.appendUsage("future-cache-warm", "other-provider", "other-model", billed);
    await expect.poll(async () => (await rows()).length, { timeout: 5_000 }).toBe(4);
    expect((await rows()).reduce((sum, row) => sum + row.usage.totalCost, 0)).toBe(session.getSessionStats().cost);
    expect(errors).toEqual([]);
}, 15_000);
