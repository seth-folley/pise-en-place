import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { fail, fields, MAX_FRAME_BYTES, text, type Message, type Params, type WorkerActor } from "./protocol.ts";

export const THREAD_WAKE_LIMIT = null;
export const ROOM_WAKE_LIMIT = 100;
export const WAKE_WINDOW_MS = 60 * 60 * 1000;
export const MAX_AUTO_BATCH = 4;
export interface Activation { id: string; messages: Message[] }
interface Row { id: string; participant_id: string; room_id: string; session_id: string; generation: number; state: string }

/** Runs inside TeamStore's authorized write transaction. No model/transport operations here. */
export class AutomationStore {
    constructor(private db: DatabaseSync, private now: () => number, private message: (room: string, id: string) => Message) {}
    private one<T>(sql: string, ...args: SQLInputValue[]): T | undefined { return this.db.prepare(sql).get(...args) as T | undefined; }
    private all<T>(sql: string, ...args: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
    private run(sql: string, ...args: SQLInputValue[]) { this.db.prepare(sql).run(...args); }
    roomUsed(room: string): number {
        return this.one<{ n: number }>("SELECT count(*) n FROM activations WHERE room_id=? AND state!='cancelled' AND created_at>?", room, this.now() - WAKE_WINDOW_MS)!.n;
    }
    private candidates(room: string, recipient?: string) {
        return this.all<{ id: string; message_id: string; recipient_id: string; thread_id: string }>(`SELECT d.id,d.message_id,d.recipient_id,m.thread_id
            FROM deliveries d JOIN messages m ON m.id=d.message_id JOIN threads t ON t.id=m.thread_id
            WHERE m.room_id=? AND (? IS NULL OR d.recipient_id=?) AND d.state='pending' AND d.activation_id IS NULL
            AND d.wake_eligible=1 AND d.obligation IN ('open','none') AND t.state='open' ORDER BY m.ordinal`, room, recipient ?? null, recipient ?? null);
    }
    blocked(room: string): number {
        return this.roomUsed(room) >= ROOM_WAKE_LIMIT ? this.candidates(room).length : 0;
    }
    private paused(actor: WorkerActor): boolean {
        return !!this.one<{ paused: number }>("SELECT (p.paused OR r.paused) paused FROM participants p JOIN rooms r ON r.id=p.room_id WHERE p.id=?", actor.participantId)!.paused;
    }
    dispatch(actor: WorkerActor, op: string, p: Params): unknown {
        fields(p, op === "auto-reserve" ? ["roomId"] : op === "auto-finish" ? ["roomId", "activationId", "outcome", "entries"] : ["roomId", "activationId"]);
        if (op === "auto-reserve") {
            if (this.paused(actor) || this.roomUsed(actor.roomId) >= ROOM_WAKE_LIMIT) return null;
            if (this.one("SELECT id FROM activations WHERE participant_id=? AND state IN ('reserved','dispatched')", actor.participantId)) return null;
            const selected = [] as ReturnType<AutomationStore["candidates"]>;
            for (const d of this.candidates(actor.roomId, actor.participantId)) {
                selected.push(d);
                if (selected.length === MAX_AUTO_BATCH) break;
            }
            if (!selected.length) return null;
            const id = randomUUID();
            this.run("INSERT INTO activations(id,room_id,participant_id,session_id,generation,state,created_at) VALUES(?,?,?,?,?,'reserved',?)", id, actor.roomId, actor.participantId, actor.sessionId, actor.generation, this.now());
            for (const thread of new Set(selected.map((d) => d.thread_id))) this.run("INSERT INTO activation_threads VALUES(?,?)", id, thread);
            for (const d of selected) this.run("UPDATE deliveries SET state='claimed',activation_id=?,attempt_id=?,session_id=?,generation=? WHERE id=?", id, randomUUID(), actor.sessionId, actor.generation, d.id);
            const batch = { id, messages: selected.map((d) => this.message(actor.roomId, d.message_id)) } satisfies Activation;
            if (Buffer.byteLength(JSON.stringify(batch)) > MAX_FRAME_BYTES - 200) fail("TOO_LARGE", "Automatic batch exceeds transport limit; reservation rolled back. Inspect messages manually.");
            return batch;
        }
        const id = text(p, "activationId", 100);
        const a = this.one<Row>("SELECT * FROM activations WHERE id=? AND room_id=? AND participant_id=? AND session_id=?", id, actor.roomId, actor.participantId, actor.sessionId) ?? fail("NOT_FOUND", "Activation does not belong to this participant/session.");
        if (op !== "auto-finish" && a.generation !== actor.generation) fail("STALE", "Activation belongs to an earlier connection generation.");
        if (op === "auto-cancel") {
            // Host calls this ONLY when it knows it never invoked Pi insertion.
            if (!["reserved", "dispatched"].includes(a.state)) return { state: a.state };
            this.cancel(a); return { state: "cancelled" };
        }
        if (op === "auto-dispatch") {
            if (a.state !== "reserved") fail("STATE", "Activation already dispatched or uncertain; never trigger it twice.");
            const obsolete = this.one(`SELECT d.id FROM deliveries d JOIN messages m ON m.id=d.message_id JOIN threads t ON t.id=m.thread_id
                WHERE d.activation_id=? AND (d.state!='claimed' OR d.obligation NOT IN ('open','none') OR t.state!='open')`, id);
            if (this.paused(actor) || obsolete) { this.cancel(a); return { state: "cancelled" }; }
            this.run("UPDATE activations SET state='dispatched' WHERE id=?", id);
            this.run("UPDATE deliveries SET state='queued' WHERE activation_id=?", id);
            return { state: "dispatched" };
        }
        if (op === "auto-finish") {
            const outcome = text(p, "outcome", 20);
            if (!["complete", "aborted", "error", "unknown"].includes(outcome)) fail("INVALID", "Invalid automatic run outcome.");
            if (!Array.isArray(p.entries) || p.entries.length > MAX_AUTO_BATCH) fail("INVALID", "Invalid recording evidence.");
            if (a.state === "cancelled" || a.state === "settled") return { state: a.state };
            for (const value of p.entries) {
                if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID", "Invalid recording evidence.");
                const entry = value as Params; fields(entry, ["messageId", "entryId"]);
                this.run("UPDATE deliveries SET state='recorded',entry_id=?,error=NULL WHERE activation_id=? AND message_id=?", text(entry, "entryId", 100), id, text(entry, "messageId", 100));
            }
            this.run("UPDATE deliveries SET state='uncertain',error='Automatic recording unproven; inspect/reconcile, never replay automatically' WHERE activation_id=? AND state IN ('claimed','queued')", id);
            const missing = this.one("SELECT id FROM deliveries WHERE activation_id=? AND state!='recorded'", id);
            const state = missing || outcome !== "complete" ? "uncertain" : "settled";
            this.run("UPDATE activations SET state=?,outcome=? WHERE id=?", state, outcome, id);
            if (outcome !== "complete") this.run("UPDATE participants SET paused=1,pause_reason=? WHERE id=?", `Automatic run ${outcome}; resume explicitly`, actor.participantId);
            return { state };
        }
        fail("OP", "Unknown activation operation.");
    }
    private cancel(a: Row): void {
        this.run("UPDATE activations SET state='cancelled' WHERE id=?", a.id);
        this.run(`UPDATE deliveries SET state=CASE WHEN obligation IN ('open','none') AND message_id IN
            (SELECT m.id FROM messages m JOIN threads t ON t.id=m.thread_id WHERE t.state='open') THEN 'pending' ELSE 'cancelled' END,
            activation_id=NULL,attempt_id=NULL,session_id=NULL,generation=NULL WHERE activation_id=? AND state IN ('claimed','queued')`, a.id);
    }
}

/** Conservative recovery: an unproven automatic run must not replay or wake after an abort/crash. */
export function interruptActivations(db: DatabaseSync, participantId?: string): void {
    const condition = participantId ? " AND participant_id=?" : "";
    const args = participantId ? [participantId] : [];
    db.prepare(`UPDATE participants SET paused=1,pause_reason='Automatic run interrupted; inspect and resume explicitly'
        WHERE id IN (SELECT participant_id FROM activations WHERE state IN ('reserved','dispatched')${condition})`).run(...args);
    db.prepare(`UPDATE activations SET state='uncertain',outcome='unknown' WHERE state IN ('reserved','dispatched')${condition}`).run(...args);
}

export function migrateAutomation(db: DatabaseSync): void {
    db.exec(`
        ALTER TABLE participants ADD COLUMN pause_reason TEXT NOT NULL DEFAULT '';
        ALTER TABLE messages ADD COLUMN actionable INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE deliveries ADD COLUMN wake_eligible INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE deliveries ADD COLUMN activation_id TEXT;
        CREATE TABLE activations (
            id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), participant_id TEXT NOT NULL REFERENCES participants(id),
            session_id TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, outcome TEXT
        );
        CREATE TABLE activation_threads (activation_id TEXT NOT NULL REFERENCES activations(id), thread_id TEXT NOT NULL REFERENCES threads(id), PRIMARY KEY(activation_id,thread_id));
        CREATE INDEX activation_room_time ON activations(room_id,created_at);
        CREATE INDEX activation_participant ON activations(participant_id,state);
        CREATE INDEX activation_thread ON activation_threads(thread_id);
        CREATE INDEX delivery_activation ON deliveries(activation_id);
        UPDATE deliveries SET wake_eligible=1 WHERE obligation='open' AND message_id IN (SELECT id FROM messages WHERE type IN ('question','decision_request')) AND recipient_id!=(SELECT sender_id FROM messages WHERE id=message_id);
        UPDATE deliveries AS d SET wake_eligible=1 WHERE d.state='pending' AND EXISTS (
            SELECT 1 FROM messages r JOIN messages q ON q.id=r.reply_to WHERE r.id=d.message_id AND r.type='reply'
            AND q.type IN ('question','decision_request') AND d.recipient_id=q.sender_id
            AND (r.author_kind='human' OR r.sender_id!=d.recipient_id)
            AND r.ordinal=(SELECT min(x.ordinal) FROM messages x WHERE x.reply_to=q.id AND x.type='reply' AND x.sender_id=r.sender_id)
        );
        PRAGMA user_version=2;
    `);
}
