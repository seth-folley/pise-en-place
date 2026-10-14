import { zstdDecompressSync } from "node:zlib";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { calculateCost, type Provider } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { afterEach, describe, expect, it, vi } from "vitest";
import fast from "../extensions/productivity/fast.ts";
import { FAST_STATUS_EVENT, FAST_STATUS_REQUEST, supportsFast, isFastStatus } from "../src/shared/fast-status.ts";

afterEach(() => { closeOpenAICodexWebSocketSessions("one"); vi.unstubAllGlobals(); });

const codexModel = {
    ...openaiCodexProvider().getModels()[0]!, id: "gpt-6.1-sol", provider: "openai-codex", api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
};

function harness(source?: Provider) {
    const handlers = new Map<string, any>();
    const commands = new Map<string, any>();
    const events = createEventBus();
    const statuses: any[] = [];
    events.on(FAST_STATUS_EVENT, status => statuses.push(status));
    const nativeStream = vi.fn((_model: any, _context: any, _options: any) => "native-stream");
    const simpleStream = vi.fn((_model: any, _context: any, _options: any) => "simple-stream");
    const providers = new Map<string, any>([["openai-codex", source ?? {
        id: "openai-codex", auth: { oauth: {} }, getModels: () => [codexModel], stream: nativeStream, streamSimple: simpleStream,
    }]]);
    const registrations = new Map<string, Provider>();
    const registerProvider = vi.fn((provider: Provider) => {
        registrations.set(provider.id, provider); providers.set(provider.id, provider);
    });
    const ctx = {
        model: { ...codexModel }, hasUI: true, ui: { notify: vi.fn() },
        sessionManager: { getSessionId: () => "one" },
        modelRegistry: {
            getProvider: (id: string) => providers.get(id),
            getRegisteredProviderIds: () => [...registrations.keys()],
            getRegisteredNativeProvider: (id: string) => registrations.get(id),
        },
        isIdle: vi.fn(() => false),
        waitForIdle: vi.fn(async () => {}),
    };
    fast({ events, on: (name: string, handler: any) => handlers.set(name, handler),
        registerCommand: (name: string, command: any) => commands.set(name, command), registerProvider } as any);
    handlers.get("session_start")({}, ctx);
    return {
        ctx, handlers, commands, statuses, events, providers, registrations, registerProvider, nativeStream, simpleStream,
        command: (args = "") => commands.get("fast").handler(args, ctx),
        request: (options: any = {}) => providers.get(ctx.model.provider).streamSimple(ctx.model, { messages: [] }, {
            sessionId: "one", apiKey: "key", reasoning: "medium", ...options,
        }),
    };
}

describe("OpenAI fast mode", () => {
    it("defaults off, toggles, warns, preserves native provider metadata and does not register repeatedly", async () => {
        const h = harness();
        expect(h.statuses.at(-1).enabled).toBe(false);
        expect(h.registerProvider).not.toHaveBeenCalled();
        await h.command();
        expect(h.statuses.at(-1).enabled).toBe(true);
        expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Additional cost/usage"), "warning");
        const wrapped = h.providers.get("openai-codex");
        expect(wrapped.auth).toEqual({ oauth: {} });
        expect(wrapped.getModels()).toEqual([codexModel]);
        expect(h.request()).toBe("native-stream");
        expect(h.nativeStream).toHaveBeenLastCalledWith(h.ctx.model, { messages: [] }, expect.objectContaining({
            serviceTier: "priority", reasoningEffort: "medium", sessionId: "one",
        }));
        await h.command("status");
        expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("eligibility is not verified"), "info");
        await h.command();
        expect(h.request()).toBe("simple-stream");
        await h.command("on"); await h.command("on");
        expect(h.registerProvider).toHaveBeenCalledOnce();
        await h.command("off");
        expect(h.statuses.at(-1).enabled).toBe(false);
    });

    it("leaves hooks, tools, sampling, cache and cancellation options intact and excludes nested requests", async () => {
        const h = harness(); await h.command("on");
        const options = { onPayload: vi.fn(), onResponse: vi.fn(), onProviderStreamEvent: vi.fn(), signal: new AbortController().signal,
            cacheRetention: "long", transport: "sse", samplingParams: { temperature: 0.2 }, headers: { example: "test" }, toolChoice: "required" };
        h.request(options);
        expect(h.nativeStream.mock.calls.at(-1)?.[2]).toMatchObject(options);
        for (const sessionId of [undefined, "one:compaction", "another-session"]) h.request({ sessionId });
        expect(h.simpleStream).toHaveBeenCalledTimes(3);
        expect(h.nativeStream).toHaveBeenCalledOnce();
        h.request({ reasoning: "off" });
        expect(h.nativeStream.mock.calls.at(-1)?.[2]).toMatchObject({ reasoningEffort: undefined, serviceTier: "priority" });
    });

    it("excludes idle auxiliary calls even when they reuse the session routing ID", async () => {
        const h = harness(); await h.command("on");
        h.ctx.isIdle.mockReturnValue(true);
        expect(h.request()).toBe("simple-stream");
        expect(h.nativeStream).not.toHaveBeenCalled();
    });

    it("does not overwrite another extension's provider and detects replacement before the next turn", async () => {
        const h = harness();
        h.registrations.set("openai-codex", h.providers.get("openai-codex"));
        await h.command("on");
        expect(h.registerProvider).not.toHaveBeenCalled();
        h.registrations.clear(); await h.command("on");
        h.registrations.set("openai-codex", {} as Provider);
        h.handlers.get("before_agent_start")({}, h.ctx);
        expect(h.statuses.at(-1).enabled).toBe(false);
        expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("registration changed"), "warning");
        await h.command("on");
        expect(h.registerProvider).toHaveBeenCalledOnce();
        h.registrations.clear();
        h.providers.set("openai-codex", { id: "openai-codex", stream: h.nativeStream, streamSimple: h.simpleStream });
        await h.command("on");
        expect(h.registerProvider).toHaveBeenCalledTimes(2);
    });

    it("cancels an idle wait without touching a context invalidated by shutdown/reload", async () => {
        const h = harness();
        let finish!: () => void;
        h.ctx.waitForIdle.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
        const command = h.command("on");
        h.handlers.get("session_shutdown")();
        Object.defineProperty(h.ctx, "hasUI", { get: () => { throw new Error("stale context"); } });
        finish(); await expect(command).resolves.toBeUndefined();
        expect(h.registerProvider).not.toHaveBeenCalled();
    });

    it("rejects unsupported connections and invalid arguments; off remains available", async () => {
        const h = harness();
        for (const model of [
            { ...codexModel, provider: "openrouter" }, { ...codexModel, api: "openai-completions" },
            { ...codexModel, baseUrl: "https://proxy.example/v1" }, { ...codexModel, api: "pi-virtual" },
        ]) {
            h.ctx.model = model;
            h.handlers.get("model_select")({}, h.ctx);
            await h.command("on");
            expect(h.statuses.at(-1).enabled).toBe(false);
            expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("unavailable"), "warning");
        }
        await h.command("off");
        expect(h.ctx.ui.notify).toHaveBeenLastCalledWith("Fast mode OFF.", "info");
        await h.command("on extra");
        expect(h.ctx.ui.notify).toHaveBeenLastCalledWith("Usage: /fast [on|off|status]", "warning");
        expect(h.registerProvider).not.toHaveBeenCalled();
        expect(h.commands.get("fast").getArgumentCompletions("o")).toHaveLength(2);
        expect(h.commands.get("fast").getArgumentCompletions("unknown")).toBeNull();
    });

    it("resets on new/resumed sessions, tree changes and model changes; never restores activation", async () => {
        const h = harness();
        for (const event of ["session_start", "session_tree"]) {
            await h.command("on"); h.handlers.get(event)({}, h.ctx);
            expect(h.statuses.at(-1).enabled).toBe(false);
        }
        await h.command("on");
        h.handlers.get("model_select")({}, h.ctx); // same selection is not a model change
        expect(h.statuses.at(-1).enabled).toBe(true);
        h.ctx.model = { ...codexModel, id: "other" };
        h.handlers.get("model_select")({}, h.ctx);
        h.ctx.model = { ...codexModel };
        h.handlers.get("model_select")({}, h.ctx);
        expect(h.statuses.at(-1).enabled).toBe(false);
        await h.command("on");
        h.handlers.get("session_shutdown")();
        expect(h.request()).toBe("simple-stream");
        h.handlers.get("session_start")({}, h.ctx);
        expect(h.statuses.at(-1).enabled).toBe(false);
    });

    it("waits for idle, cancels stale changes and only responds to its own status requests", async () => {
        const h = harness();
        let finish!: () => void;
        h.ctx.waitForIdle.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
        const command = h.command("on");
        expect(h.registerProvider).not.toHaveBeenCalled();
        h.ctx.model = { ...codexModel, id: "other" };
        h.handlers.get("model_select")({}, h.ctx); finish(); await command;
        expect(h.registerProvider).not.toHaveBeenCalled();
        expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("changed while waiting"), "warning");
        const before = h.statuses.length;
        h.events.emit(FAST_STATUS_REQUEST, "other"); expect(h.statuses).toHaveLength(before);
        h.events.emit(FAST_STATUS_REQUEST, "one"); expect(h.statuses).toHaveLength(before + 1);
        expect(isFastStatus(h.statuses.at(-1))).toBe(true);
        expect(isFastStatus({ enabled: true })).toBe(false);
    });

    it("explains priority rejection without changing the provider error or retrying", async () => {
        const h = harness(); await h.command("on");
        const message = { role: "assistant", provider: "openai-codex", model: codexModel.id, stopReason: "error",
            errorMessage: "Invalid service_tier: priority not supported for this account" };
        h.handlers.get("message_end")({ message }, h.ctx);
        expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("/fast off before retrying"), "warning");
        expect(message.errorMessage).toBe("Invalid service_tier: priority not supported for this account");
        expect(h.statuses.at(-1).enabled).toBe(true);
        expect(h.nativeStream).not.toHaveBeenCalled();
    });

    it("does not enable when provider installation fails", async () => {
        const h = harness(); h.registerProvider.mockImplementationOnce(() => { throw new Error("unsupported API"); });
        await h.command("on");
        expect(h.statuses.at(-1).enabled).toBe(false);
        expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("unchanged"), "error");
    });
});

describe("connection eligibility", () => {
    it("allows only native OpenAI Responses URLs", () => {
        expect(supportsFast(codexModel)).toBe(true);
        const model = { ...codexModel, provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" };
        expect(supportsFast(model)).toBe(true);
        expect(supportsFast({ ...codexModel, provider: "openai" })).toBe(false);
        for (const baseUrl of ["http://api.openai.com/v1", "https://api.openai.com.evil/v1", "https://api.openai.com/v1?proxy=true", "https://user@api.openai.com/v1", "bad"]) {
            expect(supportsFast({ ...model, baseUrl })).toBe(false);
        }
        expect(supportsFast(undefined)).toBe(false);
    });
});

// No network: exercise real native request builders and tier accounting through
// the extension's delegation, including Codex's default/missing-tier fallback.
describe("native priority requests and accounting", () => {
    it("sends priority over Codex WebSocket and applies native fallback pricing exactly once", async () => {
        const sent: any[] = [];
        class Socket extends EventTarget {
            readyState = 1;
            constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
            send(frame: string) {
                sent.push(JSON.parse(frame));
                queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
                    type: "response.completed", response: { id: "ws-response", status: "completed", output: [], service_tier: "default",
                        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } },
                }) })));
            }
            close() { this.readyState = 3; }
        }
        vi.stubGlobal("WebSocket", Socket);
        const h = harness(openaiCodexProvider()); await h.command("on");
        const apiKey = `header.${Buffer.from(JSON.stringify({
            "https://api.openai.com/auth": { chatgpt_account_id: "test" },
        })).toString("base64url")}.signature`;
        const fetch = vi.fn();
        const result = await h.request({ apiKey, transport: "websocket", fetch }).result();
        expect(result.stopReason).not.toBe("error");
        expect(fetch).not.toHaveBeenCalled();
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ type: "response.create", service_tier: "priority", reasoning: { effort: "medium" } });
        const baseUsage = { ...result.usage, cost: { ...result.usage.cost } };
        calculateCost(h.ctx.model as any, baseUsage);
        expect(result.usage.cost.total).toBeCloseTo(baseUsage.cost.total * 2, 12);
    });

    for (const provider of ["openai-codex", "openai"] as const) {
        for (const tier of ["priority", "default", undefined]) {
            it(`${provider}: preserves payload and native pricing with response tier ${tier}`, async () => {
                const source = provider === "openai-codex" ? openaiCodexProvider() : openaiProvider();
                const h = harness(source);
                h.providers.set(provider, source);
                const model = { ...codexModel, provider, api: provider === "openai" ? "openai-responses" : "openai-codex-responses",
                    baseUrl: provider === "openai" ? "https://api.openai.com/v1" : codexModel.baseUrl };
                h.ctx.model = model;
                h.handlers.get("model_select")({}, h.ctx);
                await h.command("on");
                const response = { id: "response-test", object: "response", status: "completed", output: [], service_tier: tier,
                    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 30 } } };
                const fetch = vi.fn(async () => new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\ndata: [DONE]\n\n`,
                    { headers: { "content-type": "text/event-stream" } }));
                const apiKey = provider === "openai" ? "test-key" : `header.${Buffer.from(JSON.stringify({
                    "https://api.openai.com/auth": { chatgpt_account_id: "test" },
                })).toString("base64url")}.signature`;
                const onPayload = vi.fn();
                const result = await h.request({ fetch, apiKey, onPayload, transport: "sse" }).result();
                expect(result.stopReason).not.toBe("error");
                expect(onPayload).toHaveBeenCalledWith(expect.objectContaining({ model: model.id,
                    service_tier: "priority", reasoning: { effort: "medium", summary: "auto" } }), expect.anything());
                expect(fetch).toHaveBeenCalledOnce();
                const input = fetch.mock.calls[0] as unknown as [unknown, { body: string | Uint8Array }];
                const body = typeof input[1].body === "string" ? input[1].body : zstdDecompressSync(input[1].body).toString();
                expect(JSON.parse(body).service_tier).toBe("priority");
                const baseUsage = { ...result.usage, cost: { ...result.usage.cost } };
                calculateCost(model as any, baseUsage);
                const multiplier = provider === "openai" && tier === "default" ? 1 : 2;
                expect(result.usage.cost.total).toBeCloseTo(baseUsage.cost.total * multiplier, 12);
            });
        }
    }
});
