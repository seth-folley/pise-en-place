import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import fast from "../extensions/productivity/fast.ts";
import { FAST_STATUS_EVENT } from "../src/shared/fast-status.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.unstubAllGlobals(); });

it("integrates with the real SDK command lifecycle, provider registry and native stream accounting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fast-sdk-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const runtime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: path.join(root, "models.json"),
        modelsStorePath: path.join(root, "models-store.json"), allowModelNetwork: false });
    await runtime.setRuntimeApiKey("openai", "offline-test-key");
    const model = runtime.getModels().find(model => model.provider === "openai" && model.api === "openai-responses")!;
    const catalog = runtime.getAllModels().map(model => `${model.provider}/${model.id}`).sort();
    const auth = runtime.getProvider("openai")!.auth;
    const classifier = runtime.getProvider("openai")!.classify;
    const statuses: any[] = [];
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [fast, pi => { pi.events.on(FAST_STATUS_EVENT, status => statuses.push(status)); }],
        agentsFilesOverride: () => ({ agentsFiles: [] }), systemPromptOverride: () => "Offline fixture." });
    await loader.reload();
    const manager = SessionManager.create(root, path.join(root, "sessions"));
    const { session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime,
        resourceLoader: loader, sessionManager: manager, settingsManager: settings, noTools: "builtin" });
    cleanup.push(async () => { await session.abort(); await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); });
    const errors: string[] = [];
    await session.bindExtensions({ onError: error => errors.push(error.error) });
    expect(statuses.at(-1).enabled).toBe(false);
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
            id: "offline-response", object: "response", status: "completed", output: [], service_tier: "priority",
            usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }));
    await session.prompt("/fast on");
    expect(statuses.at(-1).enabled).toBe(true);
    expect(runtime.getAllModels().map(model => `${model.provider}/${model.id}`).sort()).toEqual(catalog);
    expect(runtime.getProvider("openai")!.auth).toBe(auth);
    expect(runtime.getProvider("openai")!.classify).toBe(classifier);
    await session.prompt("Offline request.");
    expect(bodies).toHaveLength(1);
    expect(bodies[0].service_tier).toBe("priority");
    await session.prompt("/fast off");
    await session.prompt("Ordinary offline request.");
    expect(bodies).toHaveLength(2);
    expect(bodies[1].service_tier).toBeUndefined();
    expect(errors).toEqual([]);
    expect(manager.getEntries().some(entry => entry.type === "custom" && entry.customType.includes("fast"))).toBe(false);
}, 15_000);
