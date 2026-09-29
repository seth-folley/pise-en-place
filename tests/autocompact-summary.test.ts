import type { Model } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { estimateProjectedTokens, selectSummarySpan, summarize } from "../extensions/productivity/autocompact/summary.ts";

const model: Model<"openai-responses"> = {
    id: "test-model", name: "Test model", provider: "openai", api: "openai-responses",
    baseUrl: "https://example.invalid", reasoning: false, input: ["text"], contextWindow: 1_000_000,
    maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
    cost: { input: 0.01, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.011 } };
const assistant = {
    role: "assistant" as const, api: model.api, provider: model.provider, model: model.id,
    usage, timestamp: 0, stopReason: "toolUse" as const,
    content: [{ type: "toolCall" as const, id: "call-1", name: "read", arguments: { path: "file.ts" } }],
};

function fixture(system?: string) {
    const session = SessionManager.inMemory("/test");
    if (system) session.appendMessage({ role: "system", content: system, timestamp: 0 });
    const oldId = session.appendMessage({ role: "user", content: "OLD GOAL: preserve decisions", timestamp: 0 });
    session.appendMessage({ role: "user", content: "Read file.ts and keep working", timestamp: 1 });
    const callId = session.appendMessage(assistant);
    session.appendMessage({ role: "toolResult", toolCallId: "call-1", toolName: "read",
        content: [{ type: "text", text: "recent-file-data ".repeat(6000) }], isError: false, timestamp: 2 });
    const complete = vi.fn().mockResolvedValue({ role: "assistant", content: [{ type: "text", text: "## Goal\nKeep working.\n## Files\nfile.ts" }], stopReason: "stop", usage });
    const controller = new AbortController();
    const ctx = { model, modelRegistry: { complete }, signal: controller.signal } as unknown as ExtensionContext;
    return { session, oldId, callId, ctx, complete, controller };
}

describe("boundary compaction summaries", () => {
    it("keeps tool calls with results and commits a valid native compaction entry with usage", async () => {
        const h = fixture();
        const entries = h.session.buildSessionProjection().entries;
        const cut = selectSummarySpan(entries, 20_000);
        expect(entries[cut]!.sourceEntry.id).toBe(h.callId);
        const result = await summarize(entries, h.ctx, 250_000, "Preserve file paths");
        expect(result.firstKeptEntryId).toBe(h.callId);
        expect(result.usage).toEqual(usage);
        expect(result.summary).not.toContain("Agent handoff note");
        expect(h.complete.mock.calls[0]![1].messages[0].content).toContain("OLD GOAL");
        expect(h.complete.mock.calls[0]![1].messages[0].content).toContain("Preserve file paths");
        expect(h.complete.mock.calls[0]![2]).toMatchObject({ signal: h.controller.signal, cacheRetention: "none", maxTokens: 8192 });
        const before = h.session.getBranch().length;
        h.session.appendCompaction(result.summary, result.firstKeptEntryId, 250_000, result.details, true, result.usage);
        const projection = h.session.buildSessionProjection();
        expect(projection.messages.map(message => message.role)).toEqual(["compactionSummary", "assistant", "toolResult"]);
        expect(h.session.getBranch()).toHaveLength(before + 1); // original history is not deleted
    });

    it("summarizes projected content, including previous summaries and omitting context-edited history", async () => {
        const h = fixture();
        h.session.appendContextEdit(h.oldId, null);
        await summarize(h.session.buildSessionProjection().entries, h.ctx, 250_000);
        expect(h.complete.mock.calls[0]![1].messages[0].content).not.toContain("OLD GOAL");
        h.session.appendCompaction("PRIOR SUMMARY MARKER\n\n## Agent handoff note\nOLD NOTE: inspect file.ts", h.callId, 250_000);
        h.session.appendMessage({ role: "user", content: "Next task", timestamp: 3 });
        h.session.appendMessage({ ...assistant, content: [{ type: "toolCall", id: "call-2", name: "read", arguments: {} }] });
        h.session.appendMessage({ role: "toolResult", toolCallId: "call-2", toolName: "read",
            content: [{ type: "text", text: "new-result ".repeat(10_000) }], isError: false, timestamp: 4 });
        const result = await summarize(h.session.buildSessionProjection().entries, h.ctx, 250_000);
        const prompt = h.complete.mock.calls[1]![1].messages[0].content;
        expect(prompt).toContain("PRIOR SUMMARY MARKER");
        expect(prompt).toContain("OLD NOTE: inspect file.ts");
        expect(h.complete.mock.calls[1]![1].systemPrompt).toContain("rather than copying an old handoff note");
        expect(result.summary).not.toContain("OLD NOTE");
        expect(result.summary).not.toContain("Agent handoff note");
        expect(prompt).toContain("recent-file-data");
        expect(prompt).toContain("truncated");
    });

    it("appends a fresh note verbatim outside the summarization request and persists it in model context", async () => {
        const h = fixture();
        const note = "  Next: rerun auth tests.\nDon't change the public API.\n";
        const result = await summarize(h.session.buildSessionProjection().entries, h.ctx, 250_000, "Preserve paths", note);
        expect(result.summary).toBe(`## Goal\nKeep working.\n## Files\nfile.ts\n\n## Agent handoff note\n${note}`);
        expect(h.complete.mock.calls[0]![1].messages[0].content).not.toContain(note);
        h.session.appendCompaction(result.summary, result.firstKeptEntryId, 250_000, result.details, true, result.usage);
        expect(JSON.stringify(h.session.buildSessionProjection().messages)).toContain("Next: rerun auth tests.");
    });

    it("bounds notes before making a summary request and omits blank notes", async () => {
        const h = fixture();
        const entries = h.session.buildSessionProjection().entries;
        await expect(summarize(entries, h.ctx, 250_000, undefined, "n".repeat(1001))).rejects.toThrow("1,000");
        await expect(summarize(entries, h.ctx, 250_000, undefined, "📝".repeat(1001))).rejects.toThrow("1,000");
        expect(h.complete).not.toHaveBeenCalled();
        const result = await summarize(entries, h.ctx, 250_000, undefined, "📝".repeat(1000));
        expect(result.summary.endsWith("📝".repeat(1000))).toBe(true);
        const blank = await summarize(entries, h.ctx, 250_000, undefined, " \n\t");
        expect(blank.summary).not.toContain("Agent handoff note");
    });

    it("includes the note in post-compaction token budget validation", async () => {
        const h = fixture();
        const entries = h.session.buildSessionProjection().entries;
        const baseline = await summarize(entries, h.ctx, 250_000);
        const retained = entries.slice(selectSummarySpan(entries, 20_000));
        const limit = estimateProjectedTokens(retained) + Math.ceil(baseline.summary.length / 4) + 257;
        await expect(summarize(entries, h.ctx, limit)).resolves.toBeDefined();
        await expect(summarize(entries, h.ctx, limit, undefined, "n".repeat(1000))).rejects.toThrow("still exceed");
    });

    it("includes the captured system prompt in post-compaction size validation", async () => {
        const h = fixture("system instructions ".repeat(50_000));
        const entries = h.session.buildSessionProjection().entries;
        expect(estimateProjectedTokens(entries)).toBeGreaterThan(250_000);
        await expect(summarize(entries, h.ctx, 250_000)).rejects.toThrow("System prompt");
        expect(h.complete.mock.calls[0]![1].messages[0].content).not.toContain("system instructions");
    });

    it("rejects empty, truncated, failed, cancelled, or insufficient summaries", async () => {
        const h = fixture();
        const entries = h.session.buildSessionProjection().entries;
        for (const response of [
            { stopReason: "stop", content: [] },
            { stopReason: "length", content: [{ type: "text", text: "partial" }] },
            { stopReason: "error", errorMessage: "provider failed", content: [] },
        ]) {
            h.complete.mockResolvedValueOnce(response);
            await expect(summarize(entries, h.ctx, 250_000, undefined, "A note must not mask a failed summary")).rejects.toThrow();
        }
        await expect(summarize(entries, h.ctx, 10_000)).rejects.toThrow("still exceed");
        await expect(summarize(entries.slice(0, 1), h.ctx, 250_000)).rejects.toThrow("Not enough older");
        h.controller.abort();
        await expect(summarize(entries, h.ctx, 250_000, undefined, "Do not commit on cancellation")).rejects.toThrow("cancelled");
    });
});
