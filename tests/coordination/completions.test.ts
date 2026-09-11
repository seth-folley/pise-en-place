import { describe, expect, it } from "vitest";
import { teamArgumentCompletions } from "../../extensions/coordination/completions.ts";
import type { TeamNavigationSnapshot } from "../../src/coordination/navigation.ts";

const snapshot: TeamNavigationSnapshot = {
    room: { id: "room-1", name: "catalog" },
    participants: [{ id: "participant-1", name: "Backend", role: "worker", presence: "connected", joined: true, paused: false }],
    messages: [{ id: "message-1", threadId: "thread-1", type: "question", subject: "Need\u0085input", authorName: "Backend", sequence: 1, createdAt: 1, threadState: "open" }],
};
function values(prefix: string, value = snapshot) { return teamArgumentCompletions(prefix, value)?.map((item) => item.value) ?? []; }

describe("team argument completions", () => {
    it("uses only approved subcommands when unenrolled", () => {
        expect(values("", { participants: [], messages: [] })).toEqual(["join", "help"]);
        expect(values("j", { participants: [], messages: [] })).toEqual(["join"]);
    });
    it("returns full argument tails from cache metadata", () => {
        expect(values("read ")).toEqual(["read message-1"]);
        expect(values("resolve ")).toEqual(["resolve thread-1"]);
        expect(values("pause ")).toEqual(["pause local", "pause room"]);
        expect(values("status ")).toEqual(["status catalog", "status room-1"]);
        expect(values("status catalog ")).toEqual(["status catalog participant-1"]);
    });
    it("supports partial subcommands and empty enrolled caches", () => {
        expect(values("da")).toEqual(["dashboard"]);
        expect(values("read ", { room: { id: "room", name: "empty" }, participants: [], messages: [] })).toEqual([]);
        expect(values("status empty ", { room: { id: "room", name: "empty" }, participants: [], messages: [] })).toEqual([]);
    });
    it("deduplicates stale message and thread metadata", () => {
        const duplicate = { ...snapshot, messages: [...snapshot.messages, { ...snapshot.messages[0]! }] };
        expect(values("read ", duplicate)).toEqual(["read message-1"]);
        expect(values("thread ", duplicate)).toEqual(["thread thread-1"]);
    });
    it("does not discover rooms or expose unsafe/unbounded label text", () => {
        expect(values("join ")).toEqual([]);
        const unsafe = { ...snapshot, messages: [{ ...snapshot.messages[0]!, subject: `${"界".repeat(100)}\u0085input` }] };
        const items = teamArgumentCompletions("read ", unsafe)!;
        expect(items[0]?.label).not.toContain("\u0085");
        expect(Buffer.byteLength(items[0]?.label ?? "")).toBeLessThanOrEqual(90);
        expect(items[0]?.value).toBe("read message-1");
    });
});
