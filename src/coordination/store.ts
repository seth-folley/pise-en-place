import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
    fail, fields, flag, integer, LEASE_MS, MAX_BODY_BYTES, MESSAGE_TYPES, slug, strings, text,
    type Actor, type Credential, type Delivery, type Message, type MessageSummary, type Page,
    type Params, type Participant, type ParticipantStatus, type Room, type Runtime, type Status, type WorkerActor,
} from "./protocol.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function secretMatches(value: string, expected: string): boolean {
    return timingSafeEqual(Buffer.from(hash(value)), Buffer.from(hash(expected)));
}
type ParticipantRow = Participant & { token_hash: string };
type MessageRow = Omit<Message, "references" | "deliveries"> & { references_json: string; ordinal: number };
const SEND_FIELDS = ["roomId", "idempotencyKey", "recipients", "type", "body", "subject", "threadId", "replyTo", "references"];
function workPreview(value: string): string {
    let out = "";
    for (const char of value.replace(/\s+/g, " ")) {
        if (Buffer.byteLength(out + char) > 80) return out + "…";
        out += char;
    }
    return out;
}

/** Sole database owner. All authorization and mutation happen synchronously inside a transaction. */
export class TeamStore {
    readonly db: DatabaseSync;
    constructor(path: string, readonly now: () => number = Date.now, readonly queueLimit = 1000) {
        this.db = new DatabaseSync(path);
        try {
            this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;");
            const version = this.one<{ user_version: number }>("PRAGMA user_version")!.user_version;
            if (version !== 0 && version !== 1) fail("SCHEMA", `Unsupported database schema ${version}; preserve the database and use a compatible broker.`);
            this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
            if (version === 0) this.transaction(() => {
                this.db.exec(`
                    CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, paused INTEGER NOT NULL DEFAULT 0);
                    CREATE TABLE participants (
                        id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), name TEXT NOT NULL,
                        role TEXT NOT NULL, session_id TEXT NOT NULL, token_hash TEXT NOT NULL,
                        generation INTEGER NOT NULL DEFAULT 0, connection_id TEXT,
                        joined INTEGER NOT NULL DEFAULT 1, paused INTEGER NOT NULL DEFAULT 0,
                        runtime TEXT NOT NULL DEFAULT 'unknown', last_seen INTEGER NOT NULL DEFAULT 0,
                        summary TEXT NOT NULL DEFAULT '', blocker TEXT NOT NULL DEFAULT '', UNIQUE(room_id,name)
                    );
                    CREATE TABLE threads (
                        id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), subject TEXT NOT NULL,
                        state TEXT NOT NULL DEFAULT 'open', sequence INTEGER NOT NULL DEFAULT 0
                    );
                    CREATE TABLE messages (
                        ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
                        room_id TEXT NOT NULL REFERENCES rooms(id), thread_id TEXT NOT NULL REFERENCES threads(id),
                        sequence INTEGER NOT NULL, sender_id TEXT NOT NULL REFERENCES participants(id),
                        author_name TEXT NOT NULL, author_role TEXT NOT NULL, author_kind TEXT NOT NULL,
                        type TEXT NOT NULL, body TEXT NOT NULL, reply_to TEXT REFERENCES messages(id),
                        references_json TEXT NOT NULL, created_at INTEGER NOT NULL,
                        idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
                        UNIQUE(room_id,sender_id,idempotency_key), UNIQUE(thread_id,sequence)
                    );
                    CREATE TABLE deliveries (
                        id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id),
                        recipient_id TEXT NOT NULL REFERENCES participants(id), state TEXT NOT NULL DEFAULT 'pending',
                        obligation TEXT NOT NULL, acknowledged_at INTEGER,
                        attempt_id TEXT, session_id TEXT, generation INTEGER, entry_id TEXT, error TEXT,
                        UNIQUE(message_id,recipient_id)
                    );
                    CREATE TABLE events (
                        id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL REFERENCES rooms(id),
                        kind TEXT NOT NULL, target_id TEXT NOT NULL, details TEXT NOT NULL, created_at INTEGER NOT NULL
                    );
                    CREATE INDEX deliveries_recipient ON deliveries(recipient_id,state);
                    CREATE INDEX messages_room ON messages(room_id,ordinal);
                    PRAGMA user_version=1;
                `);
            });
            this.transaction(() => {
                this.db.exec("UPDATE participants SET connection_id=NULL,runtime='unknown'; UPDATE deliveries SET state='uncertain',error='Broker restarted during delivery' WHERE state IN ('claimed','queued');");
            });
        } catch (error) { this.db.close(); throw error; }
    }
    close(): void { this.db.close(); }
    private one<T>(sql: string, ...args: SQLInputValue[]): T | undefined { return this.db.prepare(sql).get(...args) as T | undefined; }
    private all<T>(sql: string, ...args: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
    private run(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).run(...args); }
    private transaction<T>(fn: () => T): T {
        this.db.exec("BEGIN IMMEDIATE");
        try { const result = fn(); this.db.exec("COMMIT"); return result; }
        catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
    private audit(room: string, kind: string, target: string, details: Params = {}): void {
        this.run("INSERT INTO events(room_id,kind,target_id,details,created_at) VALUES(?,?,?,?,?)", room, kind, target, JSON.stringify(details), this.now());
    }
    private participant(id: string, room: string): ParticipantRow {
        return this.one<ParticipantRow>("SELECT * FROM participants WHERE id=? AND room_id=?", id, room) ?? fail("NOT_FOUND", "Participant not found in this room.");
    }
    private room(id: string): Room { return this.one<Room>("SELECT * FROM rooms WHERE id=?", id) ?? fail("NOT_FOUND", "Room not found."); }
    private connected(p: Participant): boolean { return !!p.connection_id && p.joined === 1 && p.last_seen > this.now() - LEASE_MS; }
    private presence(p: Participant): "connected" | "disconnected" | "left" { return !p.joined ? "left" : this.connected(p) ? "connected" : "disconnected"; }
    private authorize(actor: Actor, roomId: string): void {
        if (actor.kind === "worker" && actor.roomId !== roomId) fail("FORBIDDEN", "This connection is not enrolled in that room.");
        this.room(roomId);
        if (actor.kind === "control") return;
        const p = this.participant(actor.participantId, roomId);
        if (!this.connected(p) || p.connection_id !== actor.connectionId || p.generation !== actor.generation || p.session_id !== actor.sessionId) {
            fail("STALE", "Connection lease/binding expired; reconnect the enrolled session.");
        }
    }
    private control(actor: Actor): void { if (actor.kind !== "control") fail("FORBIDDEN", "This operation requires an explicit human control."); }
    private worker(actor: Actor): WorkerActor { if (actor.kind !== "worker") fail("FORBIDDEN", "This operation requires a participant connection."); return actor; }

    enroll(params: Params, restore = false): Credential {
        fields(params, restore ? ["roomId", "participantId", "sessionId"] : ["room", "name", "role", "sessionId", "rejoin"]);
        const sessionId = text(params, "sessionId", 100);
        return this.transaction(() => {
            let room: Room;
            let existing: ParticipantRow | undefined;
            let name: string;
            let role: string;
            if (restore) {
                room = this.room(text(params, "roomId"));
                existing = this.participant(text(params, "participantId"), room.id);
                if (existing.session_id !== sessionId || !existing.joined) fail("FORBIDDEN", "Reload cannot restore a different or departed session binding.");
                name = existing.name; role = existing.role;
            } else {
                const roomName = slug(params, "room"); name = slug(params, "name"); role = slug(params, "role");
                room = this.one<Room>("SELECT * FROM rooms WHERE name=?", roomName) ?? { id: randomUUID(), name: roomName, paused: 0 };
                this.run("INSERT OR IGNORE INTO rooms(id,name) VALUES(?,?)", room.id, room.name);
                existing = this.one<ParticipantRow>("SELECT * FROM participants WHERE room_id=? AND name=?", room.id, name);
                if (existing && !flag(params, "rejoin")) fail("NAME_EXISTS", "Name already belongs to a participant. Use explicit rejoin after reviewing the previous binding.");
            }
            if (existing && this.connected(existing)) fail("IN_USE", "Participant is still connected. Leave/disconnect it first; no live takeover is allowed.");
            const sameSession = existing?.session_id === sessionId;
            const id = existing?.id ?? randomUUID();
            const token = randomBytes(32).toString("hex");
            if (existing) {
                this.run("UPDATE participants SET session_id=?,token_hash=?,joined=1,connection_id=NULL,runtime='unknown' WHERE id=?", sessionId, hash(token), id);
                // Role is durable. A rejoin is not an implicit grant or role upgrade.
                role = existing.role;
                this.run("UPDATE deliveries SET state='uncertain',error='Participant rebound during delivery' WHERE recipient_id=? AND state IN ('claimed','queued')", id);
                if (!sameSession) this.audit(room.id, "session-reassigned", id, { previousSession: existing.session_id, sessionId });
            } else {
                if (this.one<{ n: number }>("SELECT count(*) n FROM participants WHERE room_id=?", room.id)!.n >= 64) fail("CAPACITY", "Room participant limit (64) reached.");
                this.run("INSERT INTO participants(id,room_id,name,role,session_id,token_hash) VALUES(?,?,?,?,?,?)", id, room.id, name, role, sessionId, hash(token));
            }
            this.audit(room.id, restore ? "restored" : "joined", id, { sessionId });
            return { roomId: room.id, roomName: room.name, participantId: id, name, role, sessionId, token };
        });
    }
    connect(params: Params, connectionId: string): WorkerActor {
        fields(params, ["participantId", "roomId", "sessionId", "token"]);
        const room = text(params, "roomId"), id = text(params, "participantId"), sessionId = text(params, "sessionId", 100), token = text(params, "token", 100);
        return this.transaction(() => {
            const p = this.participant(id, room);
            if (p.token_hash !== hash(token) || p.session_id !== sessionId || !p.joined) fail("AUTH", "Participant credential or session binding is invalid; explicitly rejoin if needed.");
            if (this.connected(p)) fail("IN_USE", "Participant already has a live connection.");
            const generation = p.generation + 1;
            this.run("UPDATE deliveries SET state='uncertain',error='Connection replaced during delivery' WHERE recipient_id=? AND state IN ('claimed','queued')", id);
            this.run("UPDATE participants SET connection_id=?,generation=?,last_seen=?,runtime='unknown' WHERE id=?", connectionId, generation, this.now(), id);
            return { kind: "worker", participantId: id, roomId: room, sessionId, generation, connectionId };
        });
    }
    disconnect(actor: WorkerActor): void {
        this.transaction(() => {
            const p = this.participant(actor.participantId, actor.roomId);
            if (p.connection_id !== actor.connectionId || p.generation !== actor.generation) return;
            this.run("UPDATE participants SET connection_id=NULL,runtime='unknown' WHERE id=?", p.id);
            this.run("UPDATE deliveries SET state='uncertain',error='Connection closed during delivery' WHERE recipient_id=? AND state IN ('claimed','queued')", p.id);
        });
    }
    expire(): string[] {
        const rooms = this.all<{ room_id: string }>("SELECT DISTINCT room_id FROM participants WHERE connection_id IS NOT NULL AND last_seen<=?", this.now() - LEASE_MS);
        this.transaction(() => {
            this.run("UPDATE deliveries SET state='uncertain',error='Lease expired during delivery' WHERE state IN ('claimed','queued') AND recipient_id IN (SELECT id FROM participants WHERE last_seen<=?)", this.now() - LEASE_MS);
            this.run("UPDATE participants SET connection_id=NULL,runtime='unknown' WHERE connection_id IS NOT NULL AND last_seen<=?", this.now() - LEASE_MS);
        });
        return rooms.map((r) => r.room_id);
    }
    dispatch(actor: Actor, op: string, params: Params): unknown {
        const room = text(params, "roomId");
        this.authorize(actor, room);
        return this.transaction(() => {
            switch (op) {
                case "status": fields(params, ["roomId", "participantId"]); return this.status(room, actor.kind === "worker" ? actor.participantId : "", text(params, "participantId", 100, true));
                case "send": return this.send(this.worker(actor).participantId, room, params);
                case "read": return this.read(room, this.worker(actor).participantId, params);
                case "heartbeat": {
                    fields(params, ["roomId", "runtime"]);
                    const runtime = text(params, "runtime") as Runtime;
                    if (!["working", "idle", "waiting-for-user", "unknown"].includes(runtime)) fail("INVALID", "Invalid runtime state.");
                    this.run("UPDATE participants SET runtime=?,last_seen=? WHERE id=?", runtime, this.now(), this.worker(actor).participantId);
                    return { leaseMs: LEASE_MS };
                }
                case "work": {
                    fields(params, ["roomId", "summary", "blocker"]);
                    const id = this.worker(actor).participantId;
                    for (const key of ["summary", "blocker"] as const) {
                        if (params[key] !== undefined) this.run(`UPDATE participants SET ${key}=? WHERE id=?`, params[key] === "" ? "" : text(params, key, 1000), id);
                    }
                    return { updated: true };
                }
                case "ack": {
                    fields(params, ["roomId", "messageId"]);
                    const d = this.delivery(room, text(params, "messageId"), this.worker(actor).participantId);
                    this.run("UPDATE deliveries SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE id=?", this.now(), d.id);
                    return { acknowledged: true, taskComplete: false };
                }
                case "claim": return this.claim(this.worker(actor), room, params);
                case "queue": case "receipt": case "reconcile": case "uncertain": return this.receipt(this.worker(actor), room, op, params);
                case "leave": {
                    this.control(actor); fields(params, ["roomId", "participantId"]);
                    const p = this.participant(text(params, "participantId"), room);
                    this.run("UPDATE participants SET joined=0,connection_id=NULL,runtime='unknown' WHERE id=?", p.id);
                    this.run("UPDATE deliveries SET state='uncertain',error='Participant left during delivery' WHERE recipient_id=? AND state IN ('claimed','queued')", p.id);
                    this.audit(room, "left", p.id); return { left: true };
                }
                case "pause": {
                    this.control(actor); fields(params, ["roomId", "participantId", "paused"]);
                    const paused = flag(params, "paused");
                    const id = text(params, "participantId", 200, true);
                    if (id) { this.participant(id, room); this.run("UPDATE participants SET paused=? WHERE id=?", Number(paused), id); }
                    else this.run("UPDATE rooms SET paused=? WHERE id=?", Number(paused), room);
                    this.audit(room, paused ? "paused" : "resumed", id || room); return { paused };
                }
                case "retry": {
                    this.control(actor); fields(params, ["roomId", "participantId", "messageId"]);
                    const d = this.delivery(room, text(params, "messageId"), text(params, "participantId"));
                    if (d.state !== "uncertain") fail("STATE", "Only uncertain delivery can be explicitly retried.");
                    this.run("UPDATE deliveries SET state='pending',attempt_id=NULL,entry_id=NULL,error=NULL WHERE id=?", d.id);
                    this.audit(room, "delivery-retry", d.id); return { state: "pending" };
                }
                case "resolve": {
                    this.control(actor); fields(params, ["roomId", "threadId"]);
                    const thread = this.thread(room, text(params, "threadId"));
                    this.run("UPDATE threads SET state='resolved' WHERE id=?", thread.id);
                    this.run("UPDATE deliveries SET obligation=CASE WHEN obligation='open' THEN 'resolved' ELSE obligation END,state=CASE WHEN state='pending' THEN 'cancelled' ELSE state END WHERE message_id IN (SELECT id FROM messages WHERE thread_id=?)", thread.id);
                    this.audit(room, "thread-resolved", thread.id); return { resolved: true };
                }
                case "cancel": case "redirect": case "answer": return this.review(actor, room, op, params);
                default: fail("OP", `Unsupported operation: ${op}`);
            }
        });
    }
    private thread(room: string, id: string) {
        return this.one<{ id: string; state: string; subject: string }>("SELECT * FROM threads WHERE id=? AND room_id=?", id, room) ?? fail("NOT_FOUND", "Thread not found in this room.");
    }
    private delivery(room: string, message: string, recipient: string): Delivery {
        this.participant(recipient, room);
        return this.one<Delivery>("SELECT d.* FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE m.room_id=? AND d.message_id=? AND d.recipient_id=?", room, message, recipient) ?? fail("NOT_FOUND", "Delivery not found for this participant in this room.");
    }
    private message(room: string, id: string): Message {
        const row = this.one<MessageRow>("SELECT m.*,t.subject,t.state thread_state FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.room_id=? AND m.id=?", room, id) ?? fail("NOT_FOUND", "Message not found in this room.");
        const deliveries = this.all<Delivery>("SELECT * FROM deliveries WHERE message_id=? ORDER BY id", id).map((d) => {
            const p = this.participant(d.recipient_id, room);
            return { ...d, recipientName: p.name, presence: this.presence(p) };
        });
        return {
            id: row.id, room_id: room, thread_id: row.thread_id, sequence: row.sequence,
            sender_id: row.sender_id, author_name: row.author_name, author_role: row.author_role,
            author_kind: row.author_kind, type: row.type, body: row.body, reply_to: row.reply_to,
            references: JSON.parse(row.references_json), created_at: row.created_at,
            subject: row.subject, thread_state: row.thread_state, deliveries,
        };
    }
    private checkCapacity(room: string, extra: number): void {
        const n = this.one<{ n: number }>("SELECT count(*) n FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE m.room_id=? AND (d.state IN ('pending','claimed','queued','uncertain') OR d.obligation='open')", room)!.n;
        if (n + extra > this.queueLimit) fail("CAPACITY", "Room pending queue is full. Resolve/cancel existing work; no accepted messages were removed.");
    }
    private send(senderId: string, room: string, p: Params, human = false): Message {
        fields(p, SEND_FIELDS);
        const key = text(p, "idempotencyKey", 100);
        const recipients = [...new Set(strings(p, "recipients", 8, 100))].sort();
        const type = text(p, "type") as Message["type"];
        if (!MESSAGE_TYPES.includes(type)) fail("INVALID", "Invalid message type.");
        const body = text(p, "body", MAX_BODY_BYTES);
        const references = strings(p, "references", 8, 1000, true);
        const subject = text(p, "subject", 200, true);
        let threadId = text(p, "threadId", 100, true);
        const replyTo = text(p, "replyTo", 100, true);
        if (type === "reply" && !replyTo) fail("INVALID", "Replies must name replyTo and its threadId.");
        const digest = hash(JSON.stringify({ recipients, type, body, references, subject, threadId, replyTo, human }));
        const old = this.one<{ id: string; payload_hash: string }>("SELECT id,payload_hash FROM messages WHERE room_id=? AND sender_id=? AND idempotency_key=?", room, senderId, key);
        if (old) {
            if (old.payload_hash !== digest) fail("CONFLICT", "Idempotency key already used with a different payload.");
            return this.message(room, old.id);
        }
        const sender = this.participant(senderId, room);
        for (const id of recipients) this.participant(id, room); // Offline/left membership still has a durable mailbox.
        this.checkCapacity(room, recipients.length);
        if (threadId && this.thread(room, threadId).state !== "open") fail("CLOSED", "Thread is resolved; inspect its outcome instead of resuming stale work.");
        if (replyTo) {
            const original = this.message(room, replyTo);
            if (!threadId || original.thread_id !== threadId) fail("INVALID", "Reply must belong to the same room/thread.");
            if (!human && !original.deliveries.some((d) => d.recipient_id === senderId && d.state !== "cancelled" && !["redirected", "cancelled", "resolved"].includes(d.obligation))) {
                fail("FORBIDDEN", "Only a current recipient may reply to this message; cancelled/reassigned requests cannot be resumed.");
            }
            if (!recipients.includes(original.sender_id)) fail("INVALID", "Reply must address the original sender.");
        }
        if (!threadId) {
            if (!subject) fail("INVALID", "New threads require a subject.");
            threadId = randomUUID();
            this.run("INSERT INTO threads(id,room_id,subject) VALUES(?,?,?)", threadId, room, subject);
        }
        this.run("UPDATE threads SET sequence=sequence+1 WHERE id=?", threadId);
        const sequence = this.one<{ sequence: number }>("SELECT sequence FROM threads WHERE id=?", threadId)!.sequence;
        const id = randomUUID();
        this.run(`INSERT INTO messages(id,room_id,thread_id,sequence,sender_id,author_name,author_role,author_kind,type,body,reply_to,references_json,created_at,idempotency_key,payload_hash)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, room, threadId, sequence, senderId, human ? "User" : sender.name, human ? "human" : sender.role, human ? "human" : "peer", type, body, replyTo || null, JSON.stringify(references), this.now(), key, digest);
        const obligation = ["question", "decision_request"].includes(type) ? "open" : "none";
        for (const recipient of recipients) this.run("INSERT INTO deliveries(id,message_id,recipient_id,obligation) VALUES(?,?,?,?)", randomUUID(), id, recipient, obligation);
        if (replyTo && !human && type === "reply") this.run("UPDATE deliveries SET obligation='answered',state=CASE WHEN state='pending' THEN 'cancelled' ELSE state END WHERE message_id=? AND recipient_id=? AND obligation='open'", replyTo, senderId);
        this.audit(room, "message-stored", id);
        return this.message(room, id);
    }
    private read(room: string, participant: string, p: Params): Page | Message {
        fields(p, ["roomId", "messageId", "threadId", "cursor", "limit", "history"]);
        const messageId = text(p, "messageId", 100, true), threadId = text(p, "threadId", 100, true);
        if (messageId && threadId) fail("INVALID", "Choose messageId or threadId, not both.");
        const cursor = integer(p, "cursor", 0, Number.MAX_SAFE_INTEGER), limit = integer(p, "limit", 20, 20);
        const history = flag(p, "history");
        if (!limit) fail("INVALID", "Page limit must be at least 1.");
        if (messageId) return this.message(room, messageId);
        if (threadId) this.thread(room, threadId);
        const rows = threadId
            ? this.all<{ id: string; ordinal: number }>("SELECT id,ordinal FROM messages WHERE room_id=? AND thread_id=? AND ordinal>? ORDER BY ordinal LIMIT ?", room, threadId, cursor, limit + 1)
            : this.all<{ id: string; ordinal: number }>(`SELECT m.id,m.ordinal FROM messages m JOIN deliveries d ON d.message_id=m.id
                WHERE m.room_id=? AND d.recipient_id=? AND m.ordinal>? AND (? OR d.state IN ('pending','claimed','queued','uncertain')
                    OR d.obligation='open' OR (d.acknowledged_at IS NULL AND d.state='recorded' AND d.obligation='none'))
                ORDER BY m.ordinal LIMIT ?`, room, participant, cursor, Number(history), limit + 1);
        const items = rows.slice(0, limit).map((r): MessageSummary => {
            const { body, references: _refs, ...rest } = this.message(room, r.id);
            return { ...rest, preview: Array.from(body).slice(0, 160).join("") };
        });
        return { items, nextCursor: rows.length > limit ? rows[limit - 1]!.ordinal : null };
    }
    private status(room: string, you: string, participantId = ""): Status {
        if (participantId) this.participant(participantId, room);
        const participants = this.all<ParticipantRow>("SELECT * FROM participants WHERE room_id=? ORDER BY joined DESC,name", room)
            .filter((p) => !participantId || p.id === participantId).map((p): ParticipantStatus => {
            const counts = this.one<{ pending: number; unread: number; needsReply: number }>(`SELECT
                count(*) FILTER (WHERE state IN ('pending','claimed','queued','uncertain')) pending,
                count(*) FILTER (WHERE acknowledged_at IS NULL AND state!='cancelled' AND obligation IN ('open','none')) unread,
                count(*) FILTER (WHERE obligation='open') needsReply
                FROM deliveries WHERE recipient_id=?`, p.id)!;
            return {
                id: p.id, room_id: room, name: p.name, role: p.role, joined: p.joined, paused: p.paused,
                runtime: this.connected(p) ? p.runtime : "unknown", last_seen: p.last_seen,
                summary: participantId ? p.summary : workPreview(p.summary), blocker: participantId ? p.blocker : workPreview(p.blocker),
                workTruncated: !participantId && (workPreview(p.summary) !== p.summary || workPreview(p.blocker) !== p.blocker),
                presence: this.presence(p), ...counts,
            };
        });
        const attention = this.one<{ n: number }>(`SELECT count(*) n FROM deliveries d
            JOIN messages m ON m.id=d.message_id JOIN participants p ON p.id=d.recipient_id
            WHERE m.room_id=? AND (d.state='uncertain' OR ((d.state='pending' OR d.obligation='open')
                AND (p.joined=0 OR p.connection_id IS NULL OR p.last_seen<=?)))`, room, this.now() - LEASE_MS)!.n;
        const questions = this.one<{ n: number }>("SELECT count(DISTINCT m.id) n FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE m.room_id=? AND d.obligation='open'", room)!.n;
        const discussions = this.one<{ n: number }>("SELECT count(*) n FROM threads WHERE room_id=? AND state='open'", room)!.n;
        return { room: this.room(room), you, participants, questions, discussions, attention, observedAt: this.now() };
    }
    private claim(actor: WorkerActor, room: string, p: Params): Message {
        fields(p, ["roomId", "messageId"]);
        const me = this.participant(actor.participantId, room);
        if (me.paused || this.room(room).paused) fail("PAUSED", "Delivery paused. Resume explicitly before delivering.");
        const m = this.message(room, text(p, "messageId"));
        const d = this.delivery(room, m.id, me.id);
        if (m.thread_state !== "open" || ["answered", "cancelled", "resolved", "redirected"].includes(d.obligation)) fail("CLOSED", "Request is no longer active; inspect history instead.");
        if (d.state !== "pending") fail("STATE", `Delivery is ${d.state}; reconcile or deliberately retry uncertainty, never silently replay.`);
        this.run("UPDATE deliveries SET state='claimed',attempt_id=?,session_id=?,generation=?,error=NULL WHERE id=?", randomUUID(), actor.sessionId, actor.generation, d.id);
        return this.message(room, m.id);
    }
    private receipt(actor: WorkerActor, room: string, op: string, p: Params): { state: string } {
        fields(p, ["roomId", "messageId", "attemptId", "entryId"]);
        const d = this.delivery(room, text(p, "messageId"), actor.participantId);
        if (d.session_id !== actor.sessionId || !d.attempt_id || d.attempt_id !== text(p, "attemptId")) fail("STALE", "Delivery attempt belongs to a different session or attempt.");
        if (op !== "reconcile" && d.generation !== actor.generation) fail("STALE", "Stale delivery generation.");
        if (d.state === "recorded") return { state: "recorded" };
        if (!["claimed", "queued", "uncertain"].includes(d.state)) fail("STATE", "Delivery is not awaiting receipt/reconciliation.");
        if (op === "queue") {
            if (d.state === "uncertain") fail("STATE", "Uncertain delivery needs reconciliation or explicit retry, not implicit queueing.");
            this.run("UPDATE deliveries SET state='queued' WHERE id=?", d.id);
            return { state: "queued" };
        }
        if (op === "uncertain") {
            this.run("UPDATE deliveries SET state='uncertain',error='Context recording could not be proven' WHERE id=?", d.id);
            return { state: "uncertain" };
        }
        const entry = text(p, "entryId", 100);
        this.run("UPDATE deliveries SET state='recorded',entry_id=?,error=NULL WHERE id=?", entry, d.id);
        return { state: "recorded" };
    }
    private review(actor: Actor, room: string, op: string, p: Params): unknown {
        this.control(actor);
        fields(p, ["roomId", "messageId", "participantId", "recipientId", "body", "idempotencyKey"]);
        const m = this.message(room, text(p, "messageId"));
        const d = this.delivery(room, m.id, text(p, "participantId"));
        if (op === "answer") {
            // A stale human answer cannot override a reply/cancellation that arrived during review.
            // Retrying the exact already-stored human answer is still idempotent.
            const key = text(p, "idempotencyKey", 100);
            const prior = this.one("SELECT id FROM messages WHERE room_id=? AND sender_id=? AND idempotency_key=?", room, m.sender_id, key);
            if (!prior && d.obligation !== "open") fail("STATE", "Request no longer awaits this recipient's input. Refresh before answering.");
            const result = this.send(m.sender_id, room, { roomId: room, idempotencyKey: key,
                recipients: [m.sender_id, d.recipient_id].filter((v, i, a) => a.indexOf(v) === i), type: "reply",
                body: text(p, "body", MAX_BODY_BYTES), threadId: m.thread_id, replyTo: m.id }, true);
            this.run("UPDATE deliveries SET obligation='answered',state=CASE WHEN state='pending' THEN 'cancelled' ELSE state END WHERE id=? AND obligation='open'", d.id);
            if (!prior) this.audit(room, "human-answered", d.id, { replyId: result.id }); return result;
        }
        if (op === "cancel") {
            if (d.obligation === "cancelled" || (d.obligation === "none" && d.state === "cancelled")) return { cancelled: true };
            if (["answered", "resolved", "redirected"].includes(d.obligation)) fail("STATE", "Request changed since review; refresh before cancelling.");
            if (["claimed", "queued"].includes(d.state)) fail("IN_FLIGHT", "Delivery is in flight; retry cancellation after it settles.");
            this.run("UPDATE deliveries SET obligation=CASE WHEN obligation='none' THEN 'none' ELSE 'cancelled' END,state=CASE WHEN state='recorded' THEN state ELSE 'cancelled' END WHERE id=?", d.id);
            this.audit(room, "delivery-cancelled", d.id); return { cancelled: true };
        }
        const next = this.participant(text(p, "recipientId"), room);
        if (!next.joined) fail("STATE", "Redirect recipient must be joined to this room.");
        if (d.recipient_id === next.id || !["open", "none"].includes(d.obligation) || m.thread_state !== "open") fail("STATE", "This request cannot be redirected.");
        if (["claimed", "queued"].includes(d.state)) fail("IN_FLIGHT", "Delivery is in flight; retry redirection after it settles.");
        if (this.one("SELECT id FROM deliveries WHERE message_id=? AND recipient_id=?", m.id, next.id)) fail("CONFLICT", "Target already has a delivery for this message.");
        this.checkCapacity(room, 1);
        this.run("UPDATE deliveries SET obligation='redirected',state=CASE WHEN state='recorded' THEN state ELSE 'cancelled' END WHERE id=?", d.id);
        this.run("INSERT INTO deliveries(id,message_id,recipient_id,obligation) VALUES(?,?,?,?)", randomUUID(), m.id, next.id, d.obligation);
        this.audit(room, "redirected", d.id, { recipientId: next.id });
        return this.message(room, m.id);
    }
}
