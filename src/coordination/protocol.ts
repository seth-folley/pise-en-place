import { randomUUID } from "node:crypto";

export const VERSION = 1;
export const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_BODY_BYTES = 16 * 1024;
export const LEASE_MS = 20_000;
export const HEARTBEAT_MS = 5_000;
export const MESSAGE_TYPES = ["question", "reply", "proposal", "decision_request", "handoff", "status"] as const;
export type MessageType = typeof MESSAGE_TYPES[number];
export type Runtime = "working" | "idle" | "waiting-for-user" | "unknown";
export type DeliveryState = "pending" | "claimed" | "queued" | "recorded" | "uncertain" | "cancelled";
export type Obligation = "none" | "open" | "answered" | "resolved" | "cancelled" | "redirected";
export type Params = Record<string, unknown>;
export interface Request { v: 1; id: string; op: string; params: Params }
export type Response = { v: 1; id: string; ok: true; result: unknown } | { v: 1; id: string; ok: false; error: { code: string; message: string } };
export interface Changed { v: 1; event: "changed"; roomId: string }
export interface Binding { roomId: string; roomName: string; participantId: string; name: string; role: string; sessionId: string }
export interface Credential extends Binding { token: string }
export interface Room { id: string; name: string; paused: number }
export interface Participant {
    id: string; room_id: string; name: string; role: string; session_id: string;
    joined: number; paused: number; runtime: Runtime; last_seen: number;
    connection_id: string | null; generation: number; summary: string; blocker: string;
}
export interface ParticipantStatus extends Omit<Participant, "connection_id" | "generation" | "session_id"> {
    presence: "connected" | "disconnected" | "left"; pending: number; unread: number; needsReply: number; workTruncated: boolean;
}
export interface Delivery {
    id: string; message_id: string; recipient_id: string; state: DeliveryState; obligation: Obligation;
    acknowledged_at: number | null; attempt_id: string | null; session_id: string | null;
    generation: number | null; entry_id: string | null; error: string | null;
}
export interface Message {
    id: string; room_id: string; thread_id: string; sequence: number; sender_id: string;
    author_name: string; author_role: string; author_kind: "peer" | "human";
    type: MessageType; body: string; reply_to: string | null; references: string[]; created_at: number;
    subject: string; thread_state: "open" | "resolved";
    deliveries: (Delivery & { recipientName: string; presence: string })[];
}
export type MessageSummary = Omit<Message, "body" | "references"> & { preview: string };
export interface Page { items: MessageSummary[]; nextCursor: number | null }
export interface Status {
    room: Room; you: string; participants: ParticipantStatus[];
    questions: number; discussions: number; attention: number;
    observedAt: number;
}
export interface WorkerActor { kind: "worker"; participantId: string; roomId: string; sessionId: string; generation: number; connectionId: string }
export interface ControlActor { kind: "control" }
export type Actor = WorkerActor | ControlActor;

export class TeamError extends Error {
    constructor(public code: string, message: string) { super(message); this.name = "TeamError"; }
}
export function fail(code: string, message: string): never { throw new TeamError(code, message); }
export function object(value: unknown): Params {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID", "Expected an object.");
    return value as Params;
}
export function fields(p: Params, allowed: string[]): void {
    for (const key of Object.keys(p)) if (!allowed.includes(key)) fail("INVALID", `Unexpected field: ${key}`);
}
export function text(p: Params, key: string, max = 200, optional = false): string {
    const value = p[key];
    if (optional && value === undefined) return "";
    if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
        fail("INVALID", `${key} must be nonempty text of at most ${max} UTF-8 bytes, without control characters.`);
    }
    return value;
}
export function flag(p: Params, key: string): boolean {
    if (p[key] !== undefined && typeof p[key] !== "boolean") fail("INVALID", `${key} must be boolean.`);
    return p[key] === true;
}
export function integer(p: Params, key: string, fallback: number, max: number): number {
    const n = p[key] ?? fallback;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > max) fail("INVALID", `${key} is out of range.`);
    return n;
}
export function strings(p: Params, key: string, maxCount: number, maxBytes: number, optional = false): string[] {
    if (optional && p[key] === undefined) return [];
    const values = p[key];
    if (!Array.isArray(values) || values.length > maxCount || (!optional && values.length === 0)) fail("INVALID", `Invalid ${key} list.`);
    return values.map((value) => text({ value }, "value", maxBytes));
}
export function slug(p: Params, key: string): string {
    const value = text(p, key, 48);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) fail("INVALID", `${key}: use letters, numbers, dots, hyphens or underscores (max 48).`);
    return value;
}
export function request(op: string, params: Params): Request { return { v: VERSION, id: randomUUID(), op, params }; }
export function parseRequest(value: unknown): Request {
    const p = object(value);
    fields(p, ["v", "id", "op", "params"]);
    if (p.v !== VERSION) fail("VERSION", "Unsupported coordination protocol. Update broker and extension together.");
    return { v: 1, id: text(p, "id", 100), op: text(p, "op", 40), params: object(p.params) };
}
export function encode(value: unknown): Buffer {
    const bytes = Buffer.from(JSON.stringify(value) + "\n");
    if (bytes.length > MAX_FRAME_BYTES) fail("TOO_LARGE", "Protocol frame exceeds limit.");
    return bytes;
}
/** Split only on LF; JSON strings may contain other Unicode line separators. */
export class Frames {
    private pending = Buffer.alloc(0);
    push(chunk: Buffer): unknown[] {
        const frames: unknown[] = [];
        let offset = 0;
        while (offset < chunk.length) {
            const end = chunk.indexOf(10, offset);
            const part = chunk.subarray(offset, end < 0 ? chunk.length : end);
            if (this.pending.length + part.length + 1 > MAX_FRAME_BYTES) fail("TOO_LARGE", "Protocol frame exceeds limit.");
            this.pending = Buffer.concat([this.pending, part]);
            if (end < 0) break;
            try { frames.push(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.pending))); }
            catch { fail("INVALID", "Malformed UTF-8 JSON frame."); }
            this.pending = Buffer.alloc(0);
            offset = end + 1;
        }
        return frames;
    }
}
/** Plain text rendering must not execute terminal controls supplied by a peer. */
export function safeText(value: string): string { return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "�"); }
