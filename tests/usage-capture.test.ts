import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;
const cleanups: (() => Promise<void>)[] = [];
beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "usage-capture-"));
    vi.stubEnv("HOME", root);
    expect(os.homedir()).toBe(root); // Never allow this fixture to write the real ledger.
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.useRealTimers(); vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
});
const usage = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100, cost: { total: 0.5 } };
function entry(id: string, type = "message", role = "assistant") {
    return { id, type, timestamp: new Date().toISOString(), usage, kind: "future-operation", provider: "other", model: "warm-model",
        summary: "PRIVATE SUMMARY", message: { role, usage, stopReason: "error", timestamp: Date.now(),
            provider: "provider", model: "virtual", responseModel: "physical", api: "api", content: "PRIVATE RESPONSE" } };
}
async function harness(history: unknown[] = [], duringInitialization?: unknown) {
    const extension = (await import("../extensions/usage/index.ts")).default;
    const handlers = new Map<string, (...args: any[]) => Promise<void>>();
    let command: (args: string, ctx: any) => Promise<void>;
    let sessionId = "one", sessionFile: string | null = path.join(root, "one.jsonl");
    let entries: any[] = [...history, { id: "attribution", type: "custom", customType: "usage-session", data: {
        version: 1, sessionId, sessionFile, cwd: root,
        project: { name: "fixture", gitRemote: null, gitRoot: root, gitCommonDir: null, gitBranch: "main" }, tags: ["before"],
    } }];
    const notices: string[] = [];
    const ctx = { cwd: root, model: { provider: "WRONG", id: "WRONG", api: "WRONG" },
        sessionManager: { getEntries: () => entries, getBranch: () => {
            if (duringInitialization) { entries.push(duringInitialization); duringInitialization = undefined; }
            return entries;
        }, getSessionId: () => sessionId, getSessionFile: () => sessionFile },
        ui: { notify: (text: string) => notices.push(text) },
    };
    extension({ on: (name: string, handler: any) => handlers.set(name, handler),
        appendEntry: (customType: string, data: unknown) => entries.push({ id: `custom-${entries.length}`, type: "custom", customType, data }),
        registerCommand: (_name: string, definition: any) => { command = definition.handler; },
    } as any);
    const emit = async (name: string) => { await handlers.get(name)?.({}, ctx); };
    cleanups.push(() => emit("session_shutdown"));
    await emit("session_start");
    const ledgerPath = path.join(root, ".pi/agent/usage/ledger.jsonl");
    return {
        add: (...values: unknown[]) => entries.push(...values), emit, handlers,
        fork: async (id: string, ephemeral = false, fresh = false) => {
            await emit("session_before_fork");
            entries = fresh ? entries.filter(entry => entry.type === "custom") : [...entries]; sessionId = id; sessionFile = ephemeral ? null : path.join(root, `${id}.jsonl`);
            await emit("session_start");
        },
        command: async (args: string) => { await command!(args, ctx); }, notices,
        rows: async () => {
            try { return (await readFile(ledgerPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
            catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
        },
    };
}

describe("usage ledger capture", () => {
    it("captures all sources once with compatible v1 fields, authoritative attribution, and no content", async () => {
        const h = await harness([entry("old")]);
        h.add(entry("assistant"), entry("tool", "message", "toolResult")); await h.emit("turn_end");
        h.add(entry("compact", "compaction")); await h.emit("session_compact");
        h.add(entry("branch", "branch_summary")); await h.emit("session_tree");
        h.add(entry("separate", "usage")); await h.emit("agent_settled");
        await Promise.all([h.emit("turn_end"), h.emit("agent_settled")]);
        const rows = await h.rows();
        expect(rows).toHaveLength(5);
        expect(rows.map(row => row.kind)).toEqual(["assistant", "tool_result", "compaction", "branch_summary", "usage"]);
        expect(rows.every(row => row.version === 1 && row.source === "live" && row.usage.totalTokens === 100)).toBe(true);
        expect(rows[0]).toMatchObject({ provider: "provider", model: "physical", tags: ["before"] });
        expect(rows[1]).toMatchObject({ provider: null, model: null, api: null });
        expect(rows[4]).toMatchObject({ usageKind: "future-operation", provider: "other", model: "warm-model" });
        expect(JSON.stringify(rows)).not.toContain("PRIVATE");
        expect(JSON.stringify(rows)).not.toContain("WRONG");
        await h.command("lifetime --json");
        expect(JSON.parse(h.notices.at(-1)!).summary).toMatchObject({ calls: 5, totalTokens: 500, totalCost: 2.5 });
        await h.command("lifetime");
        expect(h.notices.at(-1)).toContain("Usage records: 5");
    });
    it("captures activity during async initialization without backfilling the original baseline", async () => {
        const h = await harness([entry("old")], entry("during-init", "usage"));
        expect((await h.rows()).map(row => row.sessionEntryId)).toEqual(["during-init"]);
    });

    it("captures entries appended after settlement without another prompt and releases the timer", async () => {
        const h = await harness();
        await h.emit("agent_settled"); h.add(entry("late", "usage"));
        await vi.advanceTimersByTimeAsync(2_000);
        await expect.poll(async () => (await h.rows()).length).toBe(1);
        await h.emit("session_shutdown");
        h.add(entry("after-close", "usage")); await vi.advanceTimersByTimeAsync(4_000);
        expect(await h.rows()).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
    });
    it("does not replay copied history on fork/reload, and uses the new session's identity", async () => {
        const h = await harness([entry("history")]);
        h.add(entry("new-parent")); await h.emit("turn_end");
        await h.fork("child");
        h.add(entry("new-child")); await h.emit("turn_end");
        await h.emit("session_start"); await h.emit("agent_settled");
        const rows = await h.rows();
        expect(rows.map(row => row.sessionEntryId)).toEqual(["new-parent", "new-child"]);
        expect(rows[1].id).toBe(`${path.join(root, "child.jsonl")}:new-child`);
        expect(rows[1].sessionFile).toBe(path.join(root, "child.jsonl"));
        expect(rows[1].tags).toEqual(["before"]);
        expect(vi.getTimerCount()).toBe(1);
    });
    it("isolates ephemeral sessions even when entry IDs and timestamps match", async () => {
        const h = await harness();
        await h.fork("ephemeral-one", true); h.add(entry("same")); await h.emit("turn_end");
        await h.fork("ephemeral-two", true, true); h.add(entry("same")); await h.emit("turn_end");
        const rows = await h.rows();
        expect(rows.map(row => row.id)).toEqual(["ephemeral-one:same", "ephemeral-two:same"]);
    });
    it("reconciles before a tag change and does not restore old rows after clear", async () => {
        const h = await harness();
        h.add(entry("before-tag", "usage")); await h.command("tag after");
        h.add(entry("after-tag", "usage")); await h.emit("turn_end");
        const rows = await h.rows();
        expect(rows[0].tags).toEqual(["before"]);
        expect(rows[1].tags).toEqual(["before", "after"]);
        await h.command("clear --yes"); await h.emit("agent_settled");
        expect(await h.rows()).toEqual([]);
        h.add(entry("after-clear")); await h.emit("turn_end");
        expect((await h.rows()).map(row => row.sessionEntryId)).toEqual(["after-clear"]);
    });
    it("writes the same additive v1 contract consumed by the macOS regression", async () => {
        const fixtures = (await readFile(new URL("./fixtures/usage-ledger-v1.jsonl", import.meta.url), "utf8")).trim().split("\n").map(line => JSON.parse(line));
        const h = await harness();
        for (const row of fixtures) {
            const kind = row.kind ?? "assistant";
            const source = { ...row, timestamp: Date.parse(row.timestamp), usage: { ...row.usage, cost: { total: row.usage.totalCost } } };
            h.add({ ...source, id: row.sessionEntryId, timestamp: row.timestamp, kind: row.usageKind,
                type: kind === "assistant" || kind === "tool_result" ? "message" : kind,
                message: { ...source, role: kind === "assistant" ? "assistant" : "toolResult", stopReason: "stop" },
            });
        }
        await h.emit("turn_end");
        const contract = (row: any) => ({ version: row.version, source: row.source, kind: row.kind ?? "assistant", usageKind: row.usageKind,
            provider: row.provider, model: row.model, usage: row.usage });
        expect((await h.rows()).map(contract)).toEqual(fixtures.map(contract));
    });

    it("uses persisted turn evidence instead of pre-persistence or nested tool hooks", async () => {
        const h = await harness();
        expect(h.handlers.has("message_end")).toBe(false);
        expect(h.handlers.has("tool_result")).toBe(false);
        h.add(entry("parent-result", "message", "toolResult")); await h.emit("turn_end");
        expect(await h.rows()).toHaveLength(1);
    });
});
