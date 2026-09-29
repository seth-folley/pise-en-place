import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AUTOCOMPACT_STATUS_EVENT, AUTOCOMPACT_STATUS_REQUEST } from "../src/shared/autocompact-status.ts";
import autoCompact from "../extensions/productivity/autocompact/index.ts";
import { loadConfig, saveConfig } from "../extensions/productivity/autocompact/config.ts";
import { estimateProjectedTokens, summarize } from "../extensions/productivity/autocompact/summary.ts";

vi.mock("../extensions/productivity/autocompact/config.ts", () => ({
    defaults: { enabled: false, ceilingTokens: 250_000 },
    configPath: () => "/test/autocompact.json",
    loadConfig: vi.fn(), saveConfig: vi.fn(),
}));
vi.mock("../extensions/productivity/autocompact/summary.ts", () => ({ summarize: vi.fn(), estimateProjectedTokens: vi.fn(), MAX_HANDOFF_NOTE_CHARS: 1000 }));

const draft = { type: "compaction" as const, summary: "Summary", firstKeptEntryId: "kept" };

async function harness(enabled = true) {
    vi.mocked(loadConfig).mockResolvedValue({ enabled, ceilingTokens: 250_000 });
    vi.mocked(summarize).mockResolvedValue(draft);
    const handlers = new Map<string, (...args: any[]) => any>();
    let tool: any;
    let command: any;
    const api = {
        events: createEventBus(),
        on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
        registerTool: (value: any) => { tool = value; },
        registerCommand: (_name: string, value: any) => { command = value; },
        sendMessage: vi.fn(),
    };
    let tokens: number | null = 0;
    const ctx = {
        hasUI: true,
        sessionManager: { getSessionId: () => "test-session" },
        ui: { notify: vi.fn() },
        getContextUsage: () => ({ tokens, contextWindow: 1_000_000 }),
        compact: vi.fn(), abort: vi.fn(),
        signal: new AbortController().signal,
    } as unknown as ExtensionContext;
    autoCompact(api as unknown as ExtensionAPI);
    const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
    await emit("session_start");
    const turn = (extra = {}) => emit("turn_end", {
        entries: [], outcome: "completed", message: { role: "assistant", stopReason: "toolUse", content: [] },
        context: { contextEntries: [], pendingMessages: ["queued user work"] }, ...extra,
    });
    return { ctx, api, emit, tool, command, turn, usage: (value: number | null) => { tokens = value; } };
}

beforeEach(() => vi.resetAllMocks());

describe("autocompact extension", () => {
    it("warns the agent and user without forcing another response", async () => {
        const h = await harness();
        h.usage(200_000);
        const first = await h.turn();
        expect(first.entries[0]).toMatchObject({ type: "custom_message", display: false, content: expect.stringContaining("80%") });
        expect(first.entries[0].content).toContain("Informational only: continue the task normally");
        expect(first.entries[0].content).toContain("No compaction call or handoff note is needed now");
        expect(first.entries[0].content).not.toContain("compact_context early");
        expect(first.continue).toBeUndefined();
        expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("80%"), "warning");
        expect(await h.turn()).toBeUndefined();
        h.usage(225_000);
        const warning = (await h.turn()).entries[0].content;
        expect(warning).toContain("90%");
        expect(warning).toContain("automatic compaction will handle the ceiling");
        expect(warning).toContain("Manual compaction is optional at a natural stopping point");
        expect(warning).toContain("Do not interrupt useful work");
        expect(warning).not.toContain("Compact soon");
    });

    it("describes manual compaction as optional rather than encouraging proactive use", async () => {
        const h = await harness();
        expect(h.tool.description).toContain("Normally keep working and let enabled automatic compaction handle the ceiling");
        expect(h.tool.description).toContain("when the user requests compaction");
        expect(h.tool.description).toContain("after a 90% context warning");
        expect(h.tool.description).toContain("Do not compact merely because the conversation feels long");
        expect(h.tool.description).toContain("to finish a task, or to leave a note");
        expect(h.tool.description).not.toMatch(/proactively|use early/i);
    });

    it("returns a boundary compaction without aborting or changing queue/continuation order", async () => {
        const h = await harness();
        h.usage(250_000);
        const result = await h.turn();
        expect(result).toEqual({ entries: [draft] });
        expect(summarize).toHaveBeenCalledOnce();
        expect(h.ctx.compact).not.toHaveBeenCalled();
        expect(h.ctx.abort).not.toHaveBeenCalled();
        expect(h.api.sendMessage).not.toHaveBeenCalled();
    });

    it("does not create a continuation after a final answer", async () => {
        const h = await harness();
        h.usage(260_000);
        const result = await h.turn({ message: { role: "assistant", stopReason: "stop" } });
        expect(result).toEqual({ entries: [draft] });
    });

    it("preserves earlier boundary drafts on compaction, warning, and failure paths", async () => {
        const h = await harness();
        const earlier = { type: "custom", customType: "other-extension", data: {} };
        h.usage(200_000);
        expect((await h.turn({ entries: [earlier] })).entries[0]).toBe(earlier);
        h.usage(250_000);
        expect(await h.turn({ entries: [earlier] })).toEqual({ entries: [earlier, draft] });
        await h.tool.execute("retry", {});
        vi.mocked(summarize).mockRejectedValueOnce(new Error("failure"));
        expect((await h.turn({ entries: [earlier] })).entries[0]).toBe(earlier);
        expect((await h.turn({ entries: [earlier] })).entries[0]).toBe(earlier);
    });

    it("accounts for earlier proposed messages and invalidates usage after proposed edits", async () => {
        const h = await harness();
        h.usage(249_999);
        const added = { type: "custom_message", customType: "other", display: false, content: "extra context" };
        expect(await h.turn({ entries: [added] })).toEqual({ entries: [added, draft] });
        vi.mocked(estimateProjectedTokens).mockReturnValueOnce(10_000);
        const edit = { type: "context_edit", targetId: "omitted", replacement: null };
        expect(await h.turn({ entries: [edit] })).toBeUndefined();
        expect(estimateProjectedTokens).toHaveBeenCalledWith([]);
    });

    it("honors requests from length responses that still executed tools", async () => {
        const h = await harness(false);
        await h.tool.execute("a", {});
        const result = await h.turn({ message: { role: "assistant", stopReason: "length", content: [{ type: "toolCall" }] } });
        expect(result).toEqual({ entries: [draft] });
    });

    it("rearms after user cancellation instead of treating it as insufficient compaction", async () => {
        const h = await harness();
        const controller = new AbortController();
        Object.defineProperty(h.ctx, "signal", { configurable: true, value: controller.signal });
        vi.mocked(summarize).mockImplementationOnce(async () => {
            controller.abort();
            throw new Error("aborted");
        });
        h.usage(260_000);
        expect(await h.turn()).toBeUndefined();
        Object.defineProperty(h.ctx, "signal", { value: new AbortController().signal });
        expect(await h.turn()).toEqual({ entries: [draft] });
    });

    it("defers and coalesces parallel tool requests, including while auto is off", async () => {
        const h = await harness(false);
        await Promise.all([
            h.tool.execute("a", { instructions: "Keep decisions", note: "Next: rerun auth tests." }),
            h.tool.execute("b", { instructions: "Keep file paths", note: "  Preserve the public API.\n" }),
        ]);
        expect(summarize).not.toHaveBeenCalled();
        expect(await h.turn()).toEqual({ entries: [draft] });
        expect(summarize).toHaveBeenCalledWith([], h.ctx, 250_000, "Keep decisions\n\nKeep file paths", "Next: rerun auth tests.\n\n  Preserve the public API.\n");
        expect(await h.turn()).toBeUndefined();
    });

    it("bounds aggregate parallel instructions without dropping the first request", async () => {
        const h = await harness(false);
        await h.tool.execute("a", { instructions: "a".repeat(8000) });
        await expect(h.tool.execute("b", { instructions: "b" })).rejects.toThrow("8,000");
        await h.turn();
        expect(vi.mocked(summarize).mock.calls[0]![3]).toHaveLength(8000);
    });

    it("bounds handoff notes across parallel requests without losing accepted state", async () => {
        const h = await harness(false);
        expect(h.tool.parameters.properties.note.maxLength).toBe(1000);
        await h.tool.execute("first", { instructions: "Keep decisions", note: "a".repeat(1000) });
        await expect(h.tool.execute("second", { instructions: "Must not be queued", note: "extra" })).rejects.toThrow("1,000");
        await h.turn();
        expect(summarize).toHaveBeenCalledWith([], h.ctx, 250_000, "Keep decisions", "a".repeat(1000));
    });

    it("counts Unicode code points consistently across coalesced notes", async () => {
        const h = await harness(false);
        const first = "📝".repeat(500);
        const second = "✅".repeat(498);
        await h.tool.execute("first", { note: first });
        await h.tool.execute("second", { note: second });
        await expect(h.tool.execute("extra", { note: "x" })).rejects.toThrow("1,000");
        await h.turn();
        expect(vi.mocked(summarize).mock.calls[0]![4]).toBe(`${first}\n\n${second}`);
    });

    it("allows a note alone, ignores blank notes, and does not reuse old notes", async () => {
        const h = await harness();
        await h.tool.execute("note-only", { note: "Next: run tests." });
        await h.turn();
        expect(vi.mocked(summarize).mock.calls[0]![4]).toBe("Next: run tests.");
        await h.tool.execute("blank", { note: " \n\t" });
        await h.turn();
        expect(vi.mocked(summarize).mock.calls[1]![4]).toBeUndefined();
        h.usage(10_000);
        await h.turn(); // rearm automatic policy
        h.usage(250_000);
        await h.turn();
        expect(vi.mocked(summarize).mock.calls[2]![4]).toBeUndefined();
    });

    it("does not carry cancelled notes into a subsequent request", async () => {
        const h = await harness(false);
        await h.tool.execute("cancelled", { note: "Old next step" });
        await h.turn({ outcome: "aborted" });
        await h.tool.execute("new", {});
        await h.turn();
        expect(vi.mocked(summarize).mock.calls[0]![4]).toBeUndefined();
    });

    it("disables only automatic actions; does not mutate native compaction", async () => {
        const h = await harness(false);
        h.usage(300_000);
        expect(await h.turn()).toBeUndefined();
        expect(summarize).not.toHaveBeenCalled();
        expect(saveConfig).not.toHaveBeenCalled();
    });

    it("pauses on failure rather than looping or continuing above the ceiling", async () => {
        const h = await harness();
        h.usage(260_000);
        vi.mocked(summarize).mockRejectedValueOnce(new Error("Provider unavailable"));
        const result = await h.turn();
        expect(result.entries[0].content).toContain("Provider unavailable");
        expect(h.ctx.abort).toHaveBeenCalledOnce();
        expect((await h.turn()).entries[0].content).toContain("remains above");
        expect(summarize).toHaveBeenCalledOnce();
        await h.tool.execute("retry", {});
        expect(await h.turn()).toEqual({ entries: [draft] });
        expect(summarize).toHaveBeenCalledTimes(2);
    });

    it("rearms warnings after native compaction and skips unknown usage", async () => {
        const h = await harness();
        h.usage(200_000);
        await h.turn();
        await h.emit("session_compact");
        h.usage(null);
        expect(await h.turn()).toBeUndefined();
        h.usage(200_000);
        expect((await h.turn()).entries[0].content).toContain("80%");
    });

    it("discards pending tool requests on aborted turns or session replacement", async () => {
        const h = await harness(false);
        await h.tool.execute("a", {});
        await h.turn({ outcome: "aborted" });
        await h.turn();
        await h.tool.execute("b", {});
        await h.emit("session_start");
        await h.turn();
        expect(summarize).not.toHaveBeenCalled();
    });

    it("does not commit a summary after shutdown or user cancellation", async () => {
        const h = await harness();
        let resolve!: (value: typeof draft) => void;
        vi.mocked(summarize).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
        h.usage(260_000);
        const turn = h.turn();
        await h.emit("session_shutdown");
        resolve(draft);
        expect(await turn).toBeUndefined();
        expect(h.ctx.abort).not.toHaveBeenCalled();
    });

    it("discards an in-flight handoff when native compaction supersedes it", async () => {
        const h = await harness(false);
        let resolve!: (value: typeof draft) => void;
        vi.mocked(summarize).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
        await h.tool.execute("old", { note: "Old handoff" });
        const turn = h.turn();
        await h.emit("session_compact");
        resolve(draft);
        expect(await turn).toBeUndefined();
        await h.tool.execute("new", {});
        expect(await h.turn()).toEqual({ entries: [draft] });
        expect(vi.mocked(summarize).mock.calls[1]![4]).toBeUndefined();
    });

    it("persists command changes and reports the effective thresholds", async () => {
        const h = await harness(false);
        vi.mocked(saveConfig).mockResolvedValue({ enabled: true, ceilingTokens: 250_000 });
        await h.command.handler("on", h.ctx);
        expect(saveConfig).toHaveBeenCalledWith({ enabled: true });
        expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Warning 80%   200,000 tokens\n  Warning 90%   225,000 tokens"), "info");
        h.usage(250_000);
        expect(await h.turn()).toEqual({ entries: [draft] });
        await h.command.handler("ceiling 240000", h.ctx);
        expect(saveConfig).toHaveBeenLastCalledWith({ ceilingTokens: 240_000 });
        await h.command.handler("ceiling invalid", h.ctx);
        expect(saveConfig).toHaveBeenCalledTimes(2);
    });

    it("completes subcommands with descriptions and filters argument prefixes", async () => {
        const h = await harness();
        const complete = h.command.getArgumentCompletions;
        const options = complete("");
        expect(options.map((option: { value: string }) => option.value)).toEqual(["status", "on", "off", "ceiling"]);
        expect(options.every((option: { description: string }) => option.description.length > 0)).toBe(true);
        expect(complete("o").map((option: { value: string }) => option.value)).toEqual(["on", "off"]);
        expect(complete(" st")[0].value).toBe("status");
        expect(complete("ce")[0].value).toBe("ceiling");
        for (const prefix of ["unknown", "on ", "status extra", "ceiling ", "ceiling 250000"]) {
            expect(complete(prefix)).toBeNull();
        }
        expect(saveConfig).not.toHaveBeenCalled();
    });

    it("reports current usage and limits with the explicit status command", async () => {
        const h = await harness();
        h.usage(210_000);
        await h.command.handler("status", h.ctx);
        expect(h.ctx.ui.notify).toHaveBeenLastCalledWith([
            "≡ Autocompact · enabled",
            "",
            "  Current       210,000 tokens (84.0% of effective ceiling)",
            "  Ceiling       250,000 tokens",
            "  Effective     250,000 tokens",
            "",
            "  Warning 80%   200,000 tokens",
            "  Warning 90%   225,000 tokens",
            "",
            "Pi's native compaction is unchanged.",
            "Settings: /test/autocompact.json",
        ].join("\n"), "info");
        expect(saveConfig).not.toHaveBeenCalled();
        h.usage(null);
        await h.command.handler("status", h.ctx);
        expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Current       unknown"), "info");
    });

    it("clearly separates configured and effective ceilings on smaller models", async () => {
        const h = await harness(false);
        Object.assign(h.ctx, { getContextUsage: () => ({ tokens: 100_000, contextWindow: 128_000, percent: 78.125 }) });
        await h.command.handler("status", h.ctx);
        expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("≡ Autocompact · disabled"), "info");
        expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Ceiling       250,000 tokens\n  Effective     111,616 tokens"), "info");
        expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("89.6% of effective ceiling"), "info");
    });

    it("publishes live configuration and answers session-scoped footer requests", async () => {
        const h = await harness();
        const received = vi.fn();
        h.api.events.on(AUTOCOMPACT_STATUS_EVENT, received);
        h.api.events.emit(AUTOCOMPACT_STATUS_REQUEST, "other-session");
        expect(received).not.toHaveBeenCalled();
        h.api.events.emit(AUTOCOMPACT_STATUS_REQUEST, "test-session");
        expect(received).toHaveBeenLastCalledWith({ sessionId: "test-session", enabled: true, ceilingTokens: 250_000 });
        vi.mocked(saveConfig).mockResolvedValueOnce({ enabled: false, ceilingTokens: 240_000 });
        await h.command.handler("off", h.ctx);
        expect(received).toHaveBeenLastCalledWith({ sessionId: "test-session", enabled: false, ceilingTokens: 240_000 });
        const count = received.mock.calls.length;
        await h.emit("session_shutdown");
        h.api.events.emit(AUTOCOMPACT_STATUS_REQUEST, "test-session");
        expect(received).toHaveBeenCalledTimes(count);
    });

    it("fails closed on malformed configuration without preventing manual tool use", async () => {
        const h = await harness();
        vi.mocked(loadConfig).mockRejectedValueOnce(new Error("Malformed configuration"));
        await h.emit("session_start");
        h.usage(260_000);
        expect(await h.turn()).toBeUndefined();
        expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("disabled"), "error");
        await h.tool.execute("a", {});
        expect(await h.turn()).toEqual({ entries: [draft] });
    });
});
