import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { TeamStore } from "../../src/coordination/store.ts";
import { LEASE_MS, type Credential, type Message, type Page, type Params, type Status, type WorkerActor } from "../../src/coordination/protocol.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
function setup(queueLimit = 1000) {
    const dir = mkdtempSync(join(tmpdir(), "pi-team-store-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "broker.sqlite");
    let time = 100_000;
    let store = new TeamStore(path, () => time, queueLimit);
    cleanups.push(() => store.close());
    const enroll = (name: string, room = "catalog", sessionId = `${name}-session`) => store.enroll({ room, name, role: "worker", sessionId });
    const connect = (c: Credential, connectionId = `${c.name}-connection`) => store.connect({ participantId: c.participantId, roomId: c.roomId, sessionId: c.sessionId, token: c.token }, connectionId);
    const a = enroll("app"), b = enroll("backend");
    const app = connect(a), backend = connect(b);
    const send = (params: Params = {}, actor = app): Message => store.dispatch(actor, "send", { roomId: actor.roomId, idempotencyKey: "key-1", recipients: [b.participantId], type: "question", subject: "Nullable fields", body: "Can fields be null?", ...params }) as Message;
    const call = <T = unknown>(actor: WorkerActor, op: string, params: Params = {}) => store.dispatch(actor, op, { roomId: actor.roomId, ...params }) as T;
    const control = <T = unknown>(op: string, params: Params = {}) => store.dispatch({ kind: "control" }, op, { roomId: app.roomId, ...params }) as T;
    return { get store() { return store; }, path, a, b, app, backend, enroll, connect, send, call, control,
        advance(ms = LEASE_MS + 1) { time += ms; store.expire(); },
        restart() { store.close(); store = new TeamStore(path, () => time, queueLimit); },
    };
}

describe("durable broker-owned messaging", () => {
    it("stores before returning, keeps offline mailboxes and survives restart", () => {
        const s = setup(); s.store.disconnect(s.backend);
        const m = s.send(); expect(m.deliveries[0].state).toBe("pending"); expect(m.deliveries[0].presence).toBe("disconnected");
        s.restart();
        const b = s.connect(s.b, "new");
        const page = s.call<Page>(b, "read"); expect(page.items.map((m) => m.id)).toEqual([m.id]);
        expect(s.call<Message>(b, "read", { messageId: m.id }).body).toBe("Can fields be null?");
    });
    it("deduplicates identical sends; rejects changed payload and arbitrary sender fields", () => {
        const s = setup(), m = s.send(); expect(s.send().id).toBe(m.id);
        expect(() => s.send({ body: "different" })).toThrow(/Idempotency/);
        expect(() => s.send({ from: "User" })).toThrow(/Unexpected field/);
        expect(s.call<Page>(s.backend, "read").items).toHaveLength(1);
    });
    it("orders replies, links them, and answers only the replying recipient's obligation", () => {
        const s = setup(); const c = s.enroll("reviewer"), reviewer = s.connect(c);
        const m = s.send({ recipients: [s.b.participantId, c.participantId] });
        const reply = s.send({ recipients: [s.a.participantId], type: "reply", subject: undefined, threadId: m.thread_id, replyTo: m.id, body: "Yes" }, s.backend);
        const other = s.send({ recipients: [s.a.participantId], type: "reply", threadId: m.thread_id, replyTo: m.id, body: "Agreed" }, reviewer);
        expect([m.sequence, reply.sequence, other.sequence]).toEqual([1, 2, 3]);
        const history = s.call<Page>(s.app, "read", { threadId: m.thread_id }); expect(history.items).toHaveLength(3);
        expect(history.items[0].deliveries.map((d) => d.obligation)).toEqual(["answered", "answered"]);
        expect(history.items[2].thread_state).toBe("open"); // Chat agreement isn't decision acceptance or resolution.
    });
    it("rejects invalid reply relationships and resolved threads", () => {
        const s = setup(), m = s.send();
        expect(() => s.send({ type: "reply", idempotencyKey: "r", replyTo: m.id })).toThrow(/same room\/thread/);
        expect(() => s.send({ type: "reply", threadId: m.thread_id, replyTo: m.id, idempotencyKey: "r" })).toThrow(/current recipient/);
        s.control("resolve", { threadId: m.thread_id });
        expect(() => s.send({ idempotencyKey: "r", threadId: m.thread_id })).toThrow(/resolved/);
    });
    it("tracks ack separately from delivery and task completion", () => {
        const s = setup(), m = s.send(); s.call(s.backend, "ack", { messageId: m.id });
        const d = s.call<Message>(s.backend, "read", { messageId: m.id }).deliveries[0];
        expect(d.state).toBe("pending"); expect(d.obligation).toBe("open"); expect(d.acknowledged_at).not.toBeNull();
        expect(() => s.call(s.app, "ack", { messageId: m.id })).toThrow(/Delivery not found/);
    });
    it("paginates summaries without bodies and keeps stable cursors", () => {
        const s = setup();
        for (let i = 0; i < 25; i++) s.send({ idempotencyKey: `key-${i}`, body: "x".repeat(1000) });
        const first = s.call<Page>(s.backend, "read"); expect(first.items).toHaveLength(20); expect(first.nextCursor).not.toBeNull();
        expect(first.items[0]).not.toHaveProperty("body"); expect(first.items[0].preview.length).toBe(160);
        const next = s.call<Page>(s.backend, "read", { cursor: first.nextCursor }); expect(next.items).toHaveLength(5); expect(next.nextCursor).toBeNull();
        expect(() => s.call(s.backend, "read", { limit: 21 })).toThrow(/range/);
    });
    it("bounds UTF-8 bodies, references, recipient lists, queue and payload fields", () => {
        const s = setup(1); expect(() => s.send({ body: "é".repeat(9000) })).toThrow(/UTF-8/);
        expect(() => s.send({ references: ["x".repeat(1001)] })).toThrow(/UTF-8/);
        expect(() => s.send({ recipients: Array(9).fill(s.b.participantId) })).toThrow(/list/);
        s.send(); expect(() => s.send({ idempotencyKey: "other" })).toThrow(/queue is full/);
        expect(s.send().id).toBeTruthy(); // Dedupe still works at capacity.
        expect(s.call<Page>(s.backend, "read").items).toHaveLength(1);
    });
});

describe("room, identity, and control boundaries", () => {
    it("isolates rooms even with the same participant name", () => {
        const s = setup(); const second = s.enroll("app", "website"), web = s.connect(second, "web"); const m = s.send();
        expect(second.participantId).not.toBe(s.a.participantId);
        expect(() => s.call(web, "status", { roomId: s.app.roomId })).toThrow(/not enrolled/);
        expect(() => s.call(web, "read", { messageId: m.id })).toThrow(/not found/);
        expect(() => s.send({ recipients: [second.participantId] })).toThrow(/different payload|not found/);
        expect(() => s.send({ idempotencyKey: "cross", recipients: [second.participantId] })).toThrow(/not found/);
        expect(() => s.control("redirect", { messageId: m.id, participantId: s.b.participantId, recipientId: second.participantId })).toThrow(/not found/);
        expect(s.call<Status>(web, "status").participants.map((p) => p.name)).toEqual(["app"]);
    });
    it("does not permit worker enrollment, impersonation, or human controls", () => {
        const s = setup();
        for (const op of ["leave", "pause", "retry", "resolve", "answer", "redirect", "cancel"]) expect(() => s.call(s.app, op)).toThrow(/human control/);
        expect(() => s.call(s.app, "approve")).toThrow(/Unsupported/);
        expect(() => s.store.connect({ roomId: s.a.roomId, participantId: s.a.participantId, sessionId: s.a.sessionId, token: "forged" }, "forged")).toThrow(/credential/);
    });
    it("requires explicit name recovery and forbids live takeover and fork restoration", () => {
        const s = setup();
        expect(() => s.enroll("app")).toThrow(/Name already/);
        expect(() => s.store.enroll({ room: "catalog", name: "app", role: "moderator", sessionId: "fork", rejoin: true })).toThrow(/still connected/);
        s.store.disconnect(s.app);
        expect(() => s.store.enroll({ roomId: s.a.roomId, participantId: s.a.participantId, sessionId: "fork" }, true)).toThrow(/different/);
        const restored = s.store.enroll({ roomId: s.a.roomId, participantId: s.a.participantId, sessionId: s.a.sessionId }, true);
        const next = s.connect(restored, "reload"); expect(next.generation).toBeGreaterThan(s.app.generation);
        expect(() => s.call(s.app, "status")).toThrow(/expired/);
        expect(s.call<Status>(next, "status").you).toBe(s.a.participantId);
    });
    it("explicit rejoin can rebind only disconnected participants and preserves role/history", () => {
        const s = setup(), m = s.send(); s.store.disconnect(s.backend);
        const next = s.store.enroll({ room: "catalog", name: "backend", role: "moderator", sessionId: "replacement", rejoin: true });
        expect(next.participantId).toBe(s.b.participantId); expect(next.role).toBe("worker");
        expect(s.call<Page>(s.connect(next), "read").items[0].id).toBe(m.id);
    });
    it("distinguishes idle, paused, left and expired; room pause is isolated", () => {
        const s = setup(); s.call(s.backend, "heartbeat", { runtime: "idle" });
        let status = s.call<Status>(s.app, "status"); expect(status.participants.find((p) => p.id === s.b.participantId)?.presence).toBe("connected");
        const other = s.enroll("app", "other"), otherActor = s.connect(other, "other");
        s.control("pause", { paused: true }); expect(s.call<Status>(otherActor, "status").room.paused).toBe(0);
        const m = s.send(); expect(() => s.call(s.backend, "claim", { messageId: m.id })).toThrow(/paused/);
        s.control("leave", { participantId: s.b.participantId });
        status = s.call<Status>(s.app, "status"); expect(status.participants.find((p) => p.id === s.b.participantId)?.presence).toBe("left"); expect(status.attention).toBe(1);
        s.advance(); expect(() => s.call(s.app, "status")).toThrow(/expired/);
    });
});

describe("delivery crash windows and human recovery", () => {
    it("fences attempts, surfaces disconnect uncertainty, reconciles without replay", () => {
        const s = setup(), m = s.send();
        const claimed = s.call<Message>(s.backend, "claim", { messageId: m.id }); const d = claimed.deliveries[0];
        expect(d.state).toBe("claimed");
        s.call(s.backend, "queue", { messageId: m.id, attemptId: d.attempt_id });
        expect(s.call<Message>(s.backend, "read", { messageId: m.id }).deliveries[0].state).toBe("queued");
        s.store.disconnect(s.backend);
        const b = s.connect(s.b, "reconnect");
        expect(s.call<Message>(b, "read", { messageId: m.id }).deliveries[0].state).toBe("uncertain");
        expect(() => s.call(b, "claim", { messageId: m.id })).toThrow(/uncertain/);
        expect(() => s.call(b, "receipt", { messageId: m.id, attemptId: d.attempt_id, entryId: "entry" })).toThrow(/generation/);
        s.call(b, "reconcile", { messageId: m.id, attemptId: d.attempt_id, entryId: "persisted-entry" });
        expect(s.call<Message>(b, "read", { messageId: m.id }).deliveries[0].state).toBe("recorded");
        expect(s.call<Status>(s.app, "status").questions).toBe(1); // Receipt does not answer the question.
    });
    it("restart preserves uncertainty and requires human retry without reenrolling unrelated sessions", () => {
        const s = setup(), m = s.send(); s.call(s.backend, "claim", { messageId: m.id }); s.restart();
        const b = s.connect(s.b); expect(s.call<Message>(b, "read", { messageId: m.id }).deliveries[0].state).toBe("uncertain");
        s.control("retry", { participantId: s.b.participantId, messageId: m.id });
        expect(s.call<Message>(b, "claim", { messageId: m.id }).deliveries[0].state).toBe("claimed");
    });
    it("surfaces disconnect-after-receipt as an outstanding question", () => {
        const s = setup(), m = s.send(); const claimed = s.call<Message>(s.backend, "claim", { messageId: m.id });
        s.call(s.backend, "receipt", { messageId: m.id, attemptId: claimed.deliveries[0].attempt_id, entryId: "entry" });
        s.store.disconnect(s.backend);
        expect(s.call<Status>(s.app, "status").attention).toBe(1);
    });
    it("redirects explicitly within a room and prevents stale automatic work on reconnect", () => {
        const s = setup(), c = s.enroll("reviewer"), reviewer = s.connect(c), m = s.send();
        s.control("redirect", { messageId: m.id, participantId: s.b.participantId, recipientId: c.participantId });
        const old = s.call<Message>(s.backend, "read", { messageId: m.id }).deliveries.find((d) => d.recipient_id === s.b.participantId)!;
        expect(old.state).toBe("cancelled"); expect(old.obligation).toBe("redirected");
        expect(() => s.call(s.backend, "claim", { messageId: m.id })).toThrow(/no longer active/);
        expect(s.call<Message>(reviewer, "claim", { messageId: m.id }).deliveries.find((d) => d.recipient_id === c.participantId)?.state).toBe("claimed");
    });
    it("human answers are attributable input and cancel/resolve preserve history", () => {
        const s = setup(), m = s.send();
        const answer = s.control<Message>("answer", { messageId: m.id, participantId: s.b.participantId, body: "Use null under the existing contract.", idempotencyKey: "human-key" });
        expect(answer.author_kind).toBe("human"); expect(answer.author_name).toBe("User"); expect(answer.thread_state).toBe("open");
        expect(s.call<Message>(s.app, "read", { messageId: m.id }).deliveries[0].obligation).toBe("answered");
        expect(() => s.call(s.backend, "claim", { messageId: m.id })).toThrow(/no longer active/);
        expect(() => s.control("cancel", { messageId: m.id, participantId: s.b.participantId })).toThrow(/changed since review/);
        expect(s.call<Status>(s.app, "status").questions).toBe(0);
        expect(s.call<Page>(s.backend, "read").items.map((m) => m.id)).toEqual([answer.id]);
        expect(s.call<Page>(s.backend, "read", { history: true }).items.map((m) => m.id)).toEqual([m.id, answer.id]);
        expect(s.control<Message>("answer", { messageId: m.id, participantId: s.b.participantId, body: "Use null under the existing contract.", idempotencyKey: "human-key" }).id).toBe(answer.id);
        expect(() => s.control("answer", { messageId: m.id, participantId: s.b.participantId, body: "Stale answer", idempotencyKey: "new-key" })).toThrow(/no longer awaits/);
        s.control("resolve", { threadId: m.thread_id });
        expect(s.call<Page>(s.app, "read", { threadId: m.thread_id }).items).toHaveLength(2);
    });
    it("previews large status text and supports a full participant lookup without sharing unrelated details", () => {
        const s = setup();
        s.call(s.backend, "work", { summary: "🌱".repeat(200), blocker: "Need API info. ".repeat(50) });
        const summary = s.call<Status>(s.app, "status").participants.find((p) => p.id === s.b.participantId)!;
        expect(Buffer.byteLength(summary.summary)).toBeLessThanOrEqual(83); expect(summary.workTruncated).toBe(true);
        const full = s.call<Status>(s.app, "status", { participantId: s.b.participantId });
        expect(full.participants).toHaveLength(1); expect(full.participants[0].summary).toBe("🌱".repeat(200));
        expect(full.participants[0].workTruncated).toBe(false);
    });
    it("preserves incompatible schema instead of resetting it", () => {
        const dir = mkdtempSync(join(tmpdir(), "pi-team-schema-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const path = join(dir, "data.sqlite"), db = new DatabaseSync(path);
        db.exec("CREATE TABLE keep_me (text TEXT); INSERT INTO keep_me VALUES('history'); PRAGMA user_version=9"); db.close();
        expect(() => new TeamStore(path)).toThrow(/Unsupported database schema/);
        const check = new DatabaseSync(path); expect(check.prepare("SELECT text FROM keep_me").get()?.text).toBe("history"); check.close();
    });
});
