import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { TeamStore } from "../../src/coordination/store.ts";
import type { Activation } from "../../src/coordination/automation-store.ts";
import type { Message, Params, Status, WorkerActor } from "../../src/coordination/protocol.ts";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
function setup() {
    const dir = mkdtempSync("/tmp/pi-auto-store-"); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    let now = 100_000;
    const path = join(dir, "broker.sqlite"); let store = new TeamStore(path, () => now); cleanups.push(() => store.close());
    const a = store.enroll({ room: "room", name: "app", role: "worker", sessionId: "app" });
    const b = store.enroll({ room: "room", name: "backend", role: "worker", sessionId: "backend" });
    const connect = (c: typeof a) => store.connect({ roomId: c.roomId, participantId: c.participantId, sessionId: c.sessionId, token: c.token }, Math.random().toString());
    let app = connect(a), backend = connect(b), key = 0;
    const call = <T = unknown>(actor: WorkerActor, op: string, p: Params = {}) => store.dispatch(actor, op, { roomId: a.roomId, ...p }) as T;
    const send = (p: Params = {}) => call<Message>(app, "send", { idempotencyKey: `key-${key++}`, recipients: [b.participantId], type: "question", subject: "Question", body: "Need info", ...p });
    const reserve = () => call<Activation | null>(backend, "auto-reserve");
    const finish = (batch: Activation, outcome = "complete") => {
        call(backend, "auto-dispatch", { activationId: batch.id });
        call(backend, "auto-finish", { activationId: batch.id, outcome, entries: batch.messages.map((m) => ({ messageId: m.id, entryId: `entry-${m.id}` })) });
    };
    const control = (op: string, p: Params) => store.dispatch({ kind: "control" }, op, { roomId: a.roomId, ...p });
    return { a, b, call, send, reserve, finish, control, get store() { return store; }, get app() { return app; }, get backend() { return backend; },
        restart(alreadyClosed = false) { if (!alreadyClosed) store.close(); store = new TeamStore(path, () => now); app = connect(a); backend = connect(b); },
        advance(ms: number) { now += ms; store.disconnect(app); store.disconnect(backend); app = connect(a); backend = connect(b); }, path };
}
describe("durable automatic activation policy", () => {
    it("batches actionable requests, excludes informational traffic, and never reserves a delivery twice", () => {
        const s = setup();
        for (const type of ["status", "proposal", "handoff"]) s.send({ type });
        expect(s.reserve()).toBeNull();
        const ids = [s.send(), s.send({ type: "decision_request" }), s.send({ type: "handoff", actionable: true })].map((m) => m.id);
        const batch = s.reserve()!; expect(batch.messages.map((m) => m.id)).toEqual(ids);
        expect(s.reserve()).toBeNull();
        s.finish(batch); expect(s.reserve()).toBeNull();
        expect(s.call<Status>(s.app, "status").automation.roomUsed).toBe(1);
        expect(() => s.call(s.backend, "auto-dispatch", { activationId: batch.id })).toThrow(/already dispatched/);
    });
    it("only the first requested reply wakes the requester; courtesy replies do not", () => {
        const s = setup(), q = s.send(); s.finish(s.reserve()!);
        const reply = (key: string, original: Message) => s.call<Message>(s.backend, "send", { idempotencyKey: key, recipients: [s.a.participantId], type: "reply", threadId: q.thread_id, replyTo: original.id, body: "Answer" });
        const r = reply("r1", q); reply("r2", q);
        const a = s.call<Activation>(s.app, "auto-reserve"); expect(a.messages.map((m) => m.id)).toEqual([r.id]);
        expect(s.reserve()).toBeNull(); // Answered question is retired before insertion.
        const courtesy = s.call<Message>(s.app, "send", { idempotencyKey: "thanks", recipients: [s.b.participantId], type: "reply", threadId: q.thread_id, replyTo: r.id, body: "Thanks" });
        expect(courtesy.id).toBeTruthy(); expect(s.reserve()).toBeNull();
    });
    it("allows an established thread to continue beyond four activations across restart", () => {
        const s = setup(); let threadId: string | undefined;
        for (let i = 0; i < 4; i++) {
            const m = s.send({ ...(threadId ? { threadId } : {}) }); threadId = m.thread_id;
            s.send({ threadId }); s.finish(s.reserve()!);
        }
        s.send({ threadId });
        s.restart();
        expect(s.call<Status>(s.app, "status").automation).toMatchObject({ roomUsed: 4, blocked: 0, threadLimit: null, roomLimit: 100 });
        s.finish(s.reserve()!);
        for (let i = 0; i < 20; i++) { s.send({ threadId }); s.finish(s.reserve()!); }
        expect(s.call<Status>(s.app, "status").automation.roomUsed).toBe(25);
    });
    it("enforces room-wide rolling-hour budgets across recipients and restart", () => {
        const s = setup();
        for (let i = 0; i < 100; i++) { s.send(); s.finish(s.reserve()!); }
        const m = s.send(); expect(s.reserve()).toBeNull();
        s.call(s.backend, "send", { idempotencyKey: "reverse-question", recipients: [s.a.participantId], type: "question", subject: "Other direction", body: "Need input" });
        expect(s.call(s.app, "auto-reserve")).toBeNull(); // Same room budget, different recipient.
        s.restart(); expect(s.reserve()).toBeNull();
        s.advance(3_600_001);
        expect(s.reserve()!.messages[0].id).toBe(m.id);
    });
    it.fails("counts an offline, budget-blocked delivery once in attention", () => {
        const s = setup();
        for (let i = 0; i < 100; i++) { s.send(); s.finish(s.reserve()!); }
        s.store.disconnect(s.backend);
        s.send();
        expect(s.call<Status>(s.app, "status")).toMatchObject({ attention: 1, automation: { blocked: 1 } });
    });
    it("revalidates pause and stale work before dispatch, refunds only proven uninserted cancellations", () => {
        const s = setup(); const q = s.send(), batch = s.reserve()!;
        s.control("pause", { paused: true });
        expect(s.call(s.backend, "auto-dispatch", { activationId: batch.id })).toEqual({ state: "cancelled" });
        expect(s.call<Status>(s.app, "status").automation.roomUsed).toBe(0);
        s.control("pause", { paused: false });
        const next = s.reserve()!; s.control("resolve", { threadId: q.thread_id });
        expect(s.call(s.backend, "auto-dispatch", { activationId: next.id })).toEqual({ state: "cancelled" });
        expect(s.reserve()).toBeNull();
    });
    it("aborts pause locally until explicit resume; crashes retain charged uncertainty without replay", () => {
        const s = setup(); s.send(); s.finish(s.reserve()!, "aborted");
        s.send(); expect(s.reserve()).toBeNull();
        expect(s.call<Status>(s.app, "status").participants.find((p) => p.id === s.b.participantId)?.pause_reason).toContain("aborted");
        s.control("pause", { participantId: s.b.participantId, paused: false });
        const batch = s.reserve()!; s.call(s.backend, "auto-dispatch", { activationId: batch.id });
        s.restart(); expect(s.reserve()).toBeNull();
        expect(s.call<Status>(s.app, "status").automation.roomUsed).toBe(2);
        s.control("pause", { participantId: s.b.participantId, paused: false }); expect(s.reserve()).toBeNull();
        expect(s.call<Message>(s.backend, "read", { messageId: batch.messages[0].id }).deliveries[0].state).toBe("uncertain");
    });
    it("fences actor/session ownership and supports receipt reconciliation without restarting a run", () => {
        const s = setup(); s.send(); const batch = s.reserve()!;
        expect(() => s.call(s.app, "auto-dispatch", { activationId: batch.id })).toThrow(/does not belong/);
        s.call(s.backend, "auto-dispatch", { activationId: batch.id }); s.restart();
        s.call(s.backend, "auto-finish", { activationId: batch.id, outcome: "complete", entries: [{ messageId: batch.messages[0].id, entryId: "persisted" }] });
        expect(s.reserve()).toBeNull();
        expect(s.call<Message>(s.backend, "read", { messageId: batch.messages[0].id }).deliveries[0].state).toBe("recorded");
    });
    it("migrates a schema-1 database transactionally and preserves messages/credentials", () => {
        const s = setup(); const m = s.send(), answered = s.send();
        const reply = s.call<Message>(s.backend, "send", { idempotencyKey: "legacy-reply", recipients: [s.a.participantId], type: "reply", threadId: answered.thread_id, replyTo: answered.id, body: "Existing answer" });
        s.store.close();
        // Reconstruct the exact v1 column/table layout from this populated fixture.
        const db = new DatabaseSync(s.path);
        db.exec(`DROP TABLE activation_threads; DROP TABLE activations;
            ALTER TABLE participants DROP COLUMN pause_reason;
            ALTER TABLE messages DROP COLUMN actionable;
            DROP INDEX delivery_activation; ALTER TABLE deliveries DROP COLUMN activation_id;
            ALTER TABLE deliveries DROP COLUMN wake_eligible; PRAGMA user_version=1;`);
        db.close();
        s.restart(true);
        expect(s.call<Message>(s.app, "read", { messageId: m.id }).body).toBe(m.body);
        expect(s.reserve()!.messages[0].id).toBe(m.id);
        expect(s.call<Activation>(s.app, "auto-reserve").messages[0].id).toBe(reply.id);
        expect(s.store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
    });
});
