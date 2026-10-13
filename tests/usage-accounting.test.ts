import { describe, expect, it, vi } from "vitest";
import { collectSessionUsage, LiveUsageCapture, normalizeAccountedUsage, totalSessionUsage, type SessionUsageFact } from "../src/shared/usage-accounting.ts";

const time = "2026-10-13T12:00:00Z";
const usage = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 999, reasoning: 15, cacheWrite1h: 30,
    cost: { total: 0.5 } };
const entry = (id: string, type = "message", role = "assistant") => ({ id, type, timestamp: time, usage,
    kind: "future-operation", provider: "operation-provider", model: "operation-model",
    message: { role, stopReason: "error", usage, timestamp: Date.parse(time), provider: "provider", model: "virtual",
        responseModel: "physical", api: "api", content: [{ type: "text", text: "PRIVATE RESPONSE" }] },
    summary: "PRIVATE SUMMARY", tokensBefore: 100_000 });

describe("shared usage accounting", () => {
    it("collects all canonical sources, including unknown usage kinds and failed calls", () => {
        const entries = [entry("assistant"), entry("tool", "message", "toolResult"), entry("compact", "compaction"),
            entry("branch", "branch_summary"), entry("other", "usage")];
        const facts = collectSessionUsage(entries);
        expect(facts.map(fact => fact.kind)).toEqual(["assistant", "tool_result", "compaction", "branch_summary", "usage"]);
        expect(facts[0]).toMatchObject({ provider: "provider", model: "physical", api: "api" });
        expect(facts[1]).toMatchObject({ provider: null, model: null, api: null });
        expect(facts[2]).toMatchObject({ provider: null, model: null });
        expect(facts[4]).toMatchObject({ usageKind: "future-operation", provider: "operation-provider", model: "operation-model" });
        expect(totalSessionUsage(entries)).toEqual({ input: 50, output: 100, cacheRead: 150, cacheWrite: 200,
            totalTokens: 500, totalCost: 2.5, records: 5, costedRecords: 5 });
        expect(JSON.stringify(facts)).not.toContain("PRIVATE");
        expect(JSON.stringify(facts)).not.toContain("tokensBefore");
    });
    it("deduplicates entry IDs, but not independent calls with equal usage", () => {
        expect(totalSessionUsage([entry("one"), entry("one"), entry("two")]).records).toBe(2);
    });
    it("ignores projected context edits, unknown roles, missing usage, and streaming messages", () => {
        const pending = entry("pending"); pending.message.stopReason = "pending";
        const noUsage = { ...entry("no-usage", "compaction"), usage: undefined };
        expect(collectSessionUsage([pending, noUsage, entry("user", "message", "user"), entry("edit", "context_edit"), null])).toEqual([]);
    });
    it("keeps unknown cost distinct from a reported zero and rejects invalid token counts", () => {
        expect(normalizeAccountedUsage({ input: 2, output: 1 })).toMatchObject({ totalTokens: 3, totalCost: null });
        expect(normalizeAccountedUsage({ input: 0, cost: { total: 0 } })?.totalCost).toBe(0);
        expect(normalizeAccountedUsage({ input: -1 })).toBeUndefined();
        expect(normalizeAccountedUsage({ output: NaN })).toBeUndefined();
        expect(normalizeAccountedUsage({ cacheRead: Infinity })).toBeUndefined();
        expect(normalizeAccountedUsage({ cost: { total: Infinity } })?.totalCost).toBeNull();
    });
});

describe("live-only usage capture", () => {
    it("baselines old/forked history and serializes duplicate hooks", async () => {
        const entries = [entry("old")];
        const save = vi.fn(async (_fact: SessionUsageFact) => {});
        const capture = new LiveUsageCapture(() => entries, fact => () => save(fact));
        entries.push(entry("new"));
        await Promise.all([capture.reconcile(), capture.reconcile(), capture.reconcile()]);
        expect(save).toHaveBeenCalledOnce();
        expect(save).toHaveBeenCalledWith(expect.objectContaining({ sessionEntryId: "new" }));
        await capture.close();
        entries.push(entry("after-close")); await capture.reconcile();
        expect(save).toHaveBeenCalledOnce();
    });
    it("retries a failed append without replaying earlier successful writes", async () => {
        const entries: unknown[] = [];
        const save = vi.fn(async (_fact: SessionUsageFact) => {}).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("disk unavailable"));
        const capture = new LiveUsageCapture(() => entries, fact => () => save(fact));
        entries.push(entry("one"), entry("two"));
        await expect(capture.reconcile()).rejects.toThrow("disk unavailable");
        await capture.reconcile();
        expect(save.mock.calls.map(([fact]) => fact.sessionEntryId)).toEqual(["one", "two", "two"]);
    });
    it("retains the original attribution across a failed append and tag change", async () => {
        const entries: unknown[] = [];
        let tag = "before", fail = true;
        const rows: string[] = [];
        const capture = new LiveUsageCapture(() => entries, fact => {
            const row = `${fact.sessionEntryId}:${tag}`;
            return async () => { if (fail) throw new Error("disk unavailable"); rows.push(row); };
        });
        entries.push(entry("one"));
        await expect(capture.reconcile()).rejects.toThrow("disk unavailable");
        tag = "after"; fail = false;
        await capture.reconcile();
        expect(rows).toEqual(["one:before"]);
    });

    it("snapshots attribution before asynchronous writes and drains on close", async () => {
        let entries = [entry("one")], tag = "before";
        const rows: string[] = [];
        const capture = new LiveUsageCapture(() => entries, fact => {
            const row = `${fact.sessionEntryId}:${tag}`;
            return async () => { rows.push(row); };
        }, []);
        const queued = capture.reconcile();
        tag = "after"; entries = [entry("forked-history")];
        await capture.close(); await queued;
        expect(rows).toEqual(["one:before"]);
    });
});
