import { describe, expect, it } from "vitest";
import type { Message, Page, Status } from "../../src/coordination/protocol.ts";
import {
    ackToolResult,
    formatTeamToolResult,
    readMessageToolResult,
    readPageToolResult,
    sendToolResult,
    statusToolResult,
    TEAM_TOOL_RESULT_SCHEMA,
} from "../../src/coordination/tool-results.ts";

function message(): Message {
    return {
        id: "message-1", room_id: "room-1", thread_id: "thread-1", sequence: 2, sender_id: "sender-1",
        author_name: "backend", author_role: "worker", author_kind: "peer", actionable: false, type: "question",
        body: "Need information\u0085", reply_to: null, references: ["artifact"], created_at: 123, subject: "Question", thread_state: "open",
        deliveries: [{
            id: "internal-delivery", message_id: "message-1", recipient_id: "recipient-1", recipientName: "app",
            state: "uncertain", obligation: "open", acknowledged_at: null, attempt_id: "secret-attempt",
            session_id: "secret-session", generation: 9, entry_id: "secret-entry", error: "Recording unproven", presence: "disconnected",
        }],
    };
}
function status(): Status {
    return {
        room: { id: "room-1", name: "catalog", paused: 1 }, you: "participant-1", questions: 1, discussions: 1, attention: 2, observedAt: 456,
        automation: { roomUsed: 100, roomLimit: 100, threadLimit: null, blocked: 2 },
        participants: [{
            id: "participant-1", room_id: "room-1", name: "app", role: "worker", joined: 1, paused: 1,
            runtime: "idle", last_seen: 400, summary: "Working", blocker: "", pause_reason: "Paused by user",
            presence: "connected", pending: 1, unread: 1, needsReply: 1, workTruncated: false,
        }],
    };
}
function parsed(result: ReturnType<typeof formatTeamToolResult>) {
    const value = JSON.parse(result.content[0].text);
    expect(value).toEqual(result.details);
    expect(value.schema).toBe(TEAM_TOOL_RESULT_SCHEMA);
    return value;
}

describe("versioned team tool results", () => {
    it("reports durable send acceptance and coexisting conditions without internal delivery evidence", () => {
        const value = parsed(formatTeamToolResult(sendToolResult(message(), "stable-key")));
        expect(value).toMatchObject({
            operation: "send", acceptance: "stored", idempotencyKey: "stable-key",
            conditions: ["uncertain", "waiting_offline"],
            message: { id: "message-1", threadId: "thread-1", author: { id: "sender-1" }, deliveries: [{
                recipient: { id: "recipient-1" }, state: "uncertain", obligation: "open",
                conditions: ["uncertain", "waiting_offline"],
            }] },
        });
        const serialized = JSON.stringify(value);
        for (const secret of ["internal-delivery", "secret-attempt", "secret-session", "secret-entry"]) expect(serialized).not.toContain(secret);
    });

    it("reports authoritative pause and budget conditions from status", () => {
        const value = parsed(formatTeamToolResult(statusToolResult(status(), true)));
        expect(value).toMatchObject({
            operation: "status", conditions: ["paused", "budget_blocked"], selfParticipantId: "participant-1",
            room: { paused: true }, automation: { blocked: 2, localHold: true },
            participants: [{ id: "participant-1", paused: true, conditions: ["paused"] }],
        });
        expect(JSON.stringify(value)).not.toMatch(/session_id|connection_id|generation|token/);
        const participantOnly = status(); participantOnly.room.paused = 0;
        expect(statusToolResult(participantOnly, false).conditions).toContain("paused");
    });

    it("distinguishes full messages, pages, and receipt-only acknowledgements", () => {
        const full = parsed(formatTeamToolResult(readMessageToolResult(message())));
        expect(full).toMatchObject({ operation: "read", kind: "message", message: { body: "Need information�", references: ["artifact"] } });

        const { body: _body, references: _references, ...summary } = message();
        const page: Page = { items: [{ ...summary, preview: "Need information" }], nextCursor: 42 };
        const listed = parsed(formatTeamToolResult(readPageToolResult(page, { roomId: "room-1", threadId: "thread-1", cursor: 10, history: true })));
        expect(listed).toMatchObject({ operation: "read", kind: "page", query: { threadId: "thread-1", cursor: 10, history: true }, nextCursor: 42 });
        expect(listed.items[0]).not.toHaveProperty("body");

        const ack = parsed(formatTeamToolResult(ackToolResult("room-1", "message-1")));
        expect(ack).toMatchObject({ operation: "ack", acknowledgement: "receipt", taskComplete: false, approval: false });
    });

    it("preserves the complete status ID roster while omitting work text if needed", () => {
        const large = status();
        large.room.paused = 0;
        large.participants = Array.from({ length: 64 }, (_, index) => ({
            ...large.participants[0]!,
            id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            name: `participant-${index}`,
            role: "\"".repeat(80),
            summary: "\"".repeat(80),
            blocker: "\"".repeat(80),
            paused: 0,
        }));
        large.you = large.participants[0]!.id;
        const result = formatTeamToolResult(statusToolResult(large));
        const value = parsed(result) as unknown as { truncated?: boolean; participants: Array<{ id: string; work: { omitted?: boolean } }>; omissions: { participantWork: number } };
        expect(value.truncated).toBeUndefined();
        expect(value.participants).toHaveLength(64);
        expect(value.participants.map((participant) => participant.id)).toEqual(large.participants.map((participant) => participant.id));
        expect(value.participants.every((participant) => participant.work.omitted)).toBe(true);
        expect(value.omissions.participantWork).toBe(64);
        expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(40 * 1024);
    });

    it("preserves maximum-sized quote-heavy message content with bounded base64 encoding", () => {
        const large = message();
        large.body = "\"".repeat(16 * 1024);
        large.references = Array.from({ length: 8 }, () => "\"".repeat(1000));
        const result = formatTeamToolResult(readMessageToolResult(large));
        const value = parsed(result) as { truncated?: boolean; message: { body: { encoding: string; data: string }; references: Array<{ encoding: string; data: string }> } };
        expect(value.truncated).toBeUndefined();
        expect(value.message.body.encoding).toBe("base64");
        expect(Buffer.from(value.message.body.data, "base64").toString()).toBe(large.body);
        expect(value.message.references.map((reference) => Buffer.from(reference.data, "base64").toString())).toEqual(large.references);
        expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(40 * 1024);
    });

    it("returns valid bounded JSON with reproducible retry metadata instead of cutting oversized results", () => {
        const { body: _body, references: _references, ...summary } = message();
        const page: Page = { items: Array.from({ length: 20 }, (_, index) => ({ ...summary, id: `message-${index}`, preview: "x".repeat(3 * 1024) })), nextCursor: 42 };
        const result = formatTeamToolResult(readPageToolResult(page, { roomId: "room-1", threadId: "thread-1", cursor: 5, limit: 20 }));
        const value = parsed(result);
        expect(value).toMatchObject({
            operation: "read", truncated: true,
            retry: { roomId: "room-1", threadId: "thread-1", cursor: 5, history: true, suggestedLimit: 10 },
        });
        expect(value.guidance).toContain("smaller limit");
        expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(40 * 1024);
    });
});
