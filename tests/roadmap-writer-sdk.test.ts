import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { runPrintMode } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/print-mode.js";
import roadmap from "../extensions/productivity/roadmap-writer.ts";

const captured = { stdout: [] as string[] };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
    vi.restoreAllMocks(); vi.unstubAllEnvs(); captured.stdout.length = 0;
});
async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "roadmap-print-sdk-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    vi.stubEnv("PI_CODING_AGENT_DIR", root); vi.stubEnv("PI_OFFLINE", "1");
    const file = path.join(root, "ROADMAP.md"); await writeFile(file, "# Roadmap\n");
    const runtime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: path.join(root, "models.json"),
        modelsStorePath: path.join(root, "model-store.json"), allowModelNetwork: false });
    await runtime.setRuntimeApiKey("anthropic", "fake-in-memory-test-key");
    const model = runtime.getModel("anthropic", "claude-sonnet-4-5")!;
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true,
        noSkills: true, noPromptTemplates: true, noThemes: true, agentsFilesOverride: () => ({ agentsFiles: [] }),
        systemPromptOverride: () => "Synthetic offline roadmap fixture." });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime, resourceLoader: loader,
        sessionManager: SessionManager.inMemory(root), settingsManager: settings, tools: ["read", "edit", "write"] });
    cleanup.push(async () => { await session.abort(); session.dispose(); });
    let calls = 0;
    session.agent.streamFunction = () => {
        const first = calls++ === 0;
        const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
            timestamp: Date.now(), stopReason: first ? "toolUse" : "length",
            content: first ? [{ type: "toolCall", id: "roadmap-write", name: "write", arguments: { path: "ROADMAP.md", content: "# Roadmap\n\n- Applied idea\n" } }]
                : [{ type: "text", text: "Partial final summary" }],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: first ? "toolUse" : "length", message }); stream.end(); return stream;
    };
    vi.spyOn(process.stdout, "write").mockImplementation((chunk, encodingOrCallback, callback) => {
        captured.stdout.push(String(chunk));
        const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
        queueMicrotask(() => done?.());
        return true;
    });
    // Minimal host for the pinned CLI print-mode implementation; no real provider/CLI process runs.
    const host = { session, setRebindSession() {}, dispose: async () => { session.dispose(); } } as unknown as Parameters<typeof runPrintMode>[0];
    return { root, file, host };
}

it("Pi 1.2 text print can exit 1 after a real SDK tool already changed the roadmap", async () => {
    const f = await fixture(); const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await runPrintMode(f.host, { mode: "text", messages: ["Apply the idea"] });
    expect(code).toBe(1); expect(await readFile(f.file, "utf8")).toContain("Applied idea");
    expect(captured.stdout.join("")).toContain("Partial final summary");
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("truncated"));
}, 15_000);

it("roadmap warns on a real JSON print stream even though Pi exits 0 for a truncated response", async () => {
    const f = await fixture();
    const notices: { text: string; level: string }[] = [];
    let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    const exec = vi.fn<ExtensionAPI["exec"]>(async (_command, args) => {
        expect(args[args.indexOf("--mode") + 1]).toBe("json");
        const code = await runPrintMode(f.host, { mode: "json", messages: ["Apply the idea"] });
        expect(code).toBe(0);
        return { code, killed: false, stdout: captured.stdout.join(""), stderr: "" };
    });
    roadmap({ exec, registerCommand: (_name: string, definition: any) => { handler = definition.handler; } } as unknown as ExtensionAPI);
    await handler!("Add an idea", { cwd: f.root, ui: { notify: (text: string, level: string) => notices.push({ text, level }) } } as unknown as ExtensionCommandContext);
    expect(notices.at(-1)).toMatchObject({ level: "warning", text: expect.stringContaining("changed during the run") });
    expect(notices.at(-1)?.text).toContain("truncated"); expect(notices.at(-1)?.text).toContain("Partial final summary");
    expect(notices.at(-1)?.text).not.toContain('"toolCall"');
    expect(await readFile(f.file, "utf8")).toContain("Applied idea"); expect(exec).toHaveBeenCalledOnce();
}, 15_000);
