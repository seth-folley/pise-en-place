import { describe, expect, it } from "vitest";
import { TeamNavigationCache } from "../../src/coordination/navigation.ts";
import type { Message, Status } from "../../src/coordination/protocol.ts";

function message(id = "message", createdAt = 1): Message {
    return { id, room_id: "room", thread_id: `thread-${id}`, sequence: createdAt, sender_id: "sender", author_name: "Author\u0085", author_role: "worker", author_kind: "peer", actionable: false, type: "question", body: "secret body", reply_to: null, references: ["secret reference"], created_at: createdAt, subject: `Subject ${id}`, thread_state: "open", deliveries: [{ id: "internal", message_id: id, recipient_id: "self", recipientName: "Self", presence: "connected", state: "uncertain", obligation: "open", acknowledged_at: null, attempt_id: "attempt", session_id: "session", generation: 1, entry_id: "entry", error: "error" }] };
}
function status(): Status {
    return { room: { id: "room", name: "Catalog", paused: 0 }, you: "self", questions: 0, discussions: 0, attention: 0, observedAt: 1, automation: { roomUsed: 0, roomLimit: 1, threadLimit: null, blocked: 0 }, participants: [{ id: "self", room_id: "room", name: "Self", role: "worker", joined: 1, paused: 0, runtime: "idle", last_seen: 1, summary: "secret", blocker: "secret", pause_reason: "secret", presence: "connected", pending: 0, unread: 0, needsReply: 0, workTruncated: false }] };
}

describe("TeamNavigationCache", () => {
    it("keeps only allowlisted metadata and returns immutable snapshots", () => {
        const cache = new TeamNavigationCache();
        cache.rememberStatus(status(), "self"); cache.rememberMessage(message(), "self");
        const snapshot = cache.snapshot();
        expect(snapshot).toMatchObject({ room: { id: "room", name: "Catalog" }, participants: [{ id: "self", joined: true }], messages: [{ id: "message", ownDeliveryState: "uncertain" }] });
        expect(JSON.stringify(snapshot)).not.toMatch(/secret|attempt|session|internal|body|reference/);
        (snapshot.messages as unknown as { subject: string }[])[0].subject = "mutated";
        expect(cache.snapshot().messages[0]?.subject).toBe("Subject message");
    });
    it("deduplicates IDs, orders newest first, and isolates the current room", () => {
        const cache = new TeamNavigationCache();
        cache.rememberMessage(message("old", 1), "self"); cache.rememberMessage(message("new", 2), "self");
        cache.rememberMessage({ ...message("old", 3), subject: "Updated" }, "self");
        expect(cache.snapshot().messages.map((item) => item.id)).toEqual(["old", "new"]);
        cache.rememberMessage({ ...message("other", 4), room_id: "other" }, "self");
        expect(cache.snapshot()).toMatchObject({ room: { id: "room" }, messages: [{ id: "old" }, { id: "new" }] });
        cache.reset("other");
        cache.rememberMessage({ ...message("other", 4), room_id: "other" }, "self");
        expect(cache.snapshot()).toMatchObject({ room: { id: "other" }, messages: [{ id: "other" }] });
        cache.reset(); expect(cache.snapshot()).toEqual({ participants: [], messages: [] });
    });
    it("bounds participants and evicts the oldest participant metadata", () => {
        const cache = new TeamNavigationCache();
        const value = status();
        value.participants = Array.from({ length: 140 }, (_, index) => ({ ...value.participants[0]!, id: `p${index}`, name: `Peer ${index}` }));
        cache.rememberStatus(value, "self");
        const participants = cache.snapshot().participants;
        expect(participants).toHaveLength(128);
        expect(participants.some((participant) => participant.id === "p0")).toBe(false);
        expect(participants.some((participant) => participant.id === "p139")).toBe(true);
    });
    it("bounds message count", () => {
        const cache = new TeamNavigationCache();
        for (let index = 0; index < 110; index++) cache.rememberMessage(message(`m${index}`, index), "self");
        const messages = cache.snapshot().messages;
        expect(messages).toHaveLength(100);
        expect(messages[0]?.id).toBe("m109");
        expect(messages.at(-1)?.id).toBe("m10");
    });
    it("evicts oldest metadata by UTF-8 byte size and sanitizes Unicode controls", () => {
        const cache = new TeamNavigationCache();
        for (let index = 0; index < 100; index++) {
            cache.rememberMessage({ ...message(`m${index}`, index), subject: `${"界".repeat(400)}\u0085${index}` }, "self");
        }
        const snapshot = cache.snapshot();
        expect(Buffer.byteLength(JSON.stringify(snapshot.messages))).toBeLessThanOrEqual(64 * 1024);
        expect(snapshot.messages[0]?.id).toBe("m99");
        expect(snapshot.messages.at(-1)?.id).not.toBe("m0");
        expect(JSON.stringify(snapshot)).not.toContain("\u0085");
    });
});
