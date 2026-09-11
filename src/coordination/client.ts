import { createConnection, type Socket } from "node:net";
import type { Activation } from "./automation-store.ts";
import { encode, Frames, object, request, TeamError, type Credential, type Message, type MessageType, type Page, type Params, type Response, type Runtime, type Status } from "./protocol.ts";
import { readControl, type TeamPaths } from "./paths.ts";

type RecordingEvidence = { messageId: string; entryId: string };
type StateResult = { state: string };
type ReadParams = { roomId: string; messageId?: string; threadId?: string; cursor?: number; limit?: number; history?: boolean };
export interface WorkerOperations {
    status: { params: { roomId: string; participantId?: string }; result: Status };
    send: { params: { roomId: string; idempotencyKey: string; recipients: string[]; type: MessageType; body: string; subject?: string; threadId?: string; replyTo?: string; references?: string[]; actionable?: boolean }; result: Message };
    read: { params: ReadParams; result: Message | Page };
    heartbeat: { params: { roomId: string; runtime: Runtime }; result: { leaseMs: number } };
    work: { params: { roomId: string; summary?: string; blocker?: string }; result: { updated: true } };
    ack: { params: { roomId: string; messageId: string }; result: { acknowledged: true; taskComplete: false } };
    claim: { params: { roomId: string; messageId: string }; result: Message };
    queue: { params: { roomId: string; messageId: string; attemptId: string }; result: StateResult };
    receipt: { params: { roomId: string; messageId: string; attemptId: string; entryId: string }; result: StateResult };
    reconcile: { params: { roomId: string; messageId: string; attemptId: string; entryId: string }; result: StateResult };
    uncertain: { params: { roomId: string; messageId: string; attemptId: string }; result: StateResult };
    "auto-reserve": { params: { roomId: string }; result: Activation | null };
    "auto-dispatch": { params: { roomId: string; activationId: string }; result: StateResult };
    "auto-cancel": { params: { roomId: string; activationId: string }; result: StateResult };
    "auto-reconcile": { params: { roomId: string; activationId: string; entries: RecordingEvidence[] }; result: StateResult };
    "auto-finish": { params: { roomId: string; activationId: string; outcome: "complete" | "aborted" | "error" | "unknown"; entries: RecordingEvidence[] }; result: StateResult };
}
interface Health { protocol: number; schema: number; activationPolicy?: number; status: string }
export interface ControlOperations {
    join: { params: { room: string; name: string; role: string; sessionId: string; rejoin?: boolean }; result: Credential };
    restore: { params: { roomId: string; participantId: string; sessionId: string }; result: Credential };
    health: { params: Record<string, never>; result: Health };
    stop: { params: Record<string, never>; result: Health };
    status: WorkerOperations["status"];
    leave: { params: { roomId: string; participantId: string }; result: { left: true } };
    pause: { params: { roomId: string; participantId?: string; paused: boolean }; result: { paused: boolean } };
    retry: { params: { roomId: string; participantId: string; messageId: string }; result: StateResult };
    resolve: { params: { roomId: string; threadId: string }; result: { resolved: true } };
    cancel: { params: { roomId: string; messageId: string; participantId: string }; result: { cancelled: true } };
    redirect: { params: { roomId: string; messageId: string; participantId: string; recipientId: string }; result: unknown };
    answer: { params: { roomId: string; messageId: string; participantId: string; body: string; idempotencyKey: string }; result: unknown };
}
export type OperationParams<Operations, Name extends keyof Operations> = Operations[Name] extends { params: infer Value } ? Value : never;
export type OperationResult<Operations, Name extends keyof Operations> = Operations[Name] extends { result: infer Value } ? Value : never;
type CallResult<Operations, Name extends keyof Operations, Parameters> = Name extends "read"
    ? Parameters extends { messageId: string } ? Message : Page
    : OperationResult<Operations, Name>;
export type WorkerHello = { roomId: string; participantId: string; sessionId: string; token: string };
export interface OperationCaller<Operations> {
    call<Name extends keyof Operations & string, Parameters extends OperationParams<Operations, Name>>(op: Name, params: Parameters, signal?: AbortSignal): Promise<CallResult<Operations, Name, Parameters>>;
}

export class TeamClient<Operations = WorkerOperations> implements OperationCaller<Operations> {
    private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }>();
    private closed = false;
    onChanged?: (room: string) => void;
    onClose?: () => void;
    private constructor(private readonly socket: Socket, private readonly timeoutMs: number) {
        const frames = new Frames();
        socket.on("data", (chunk) => {
            try {
                for (const value of frames.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
                    const p = object(value);
                    if (p.v !== 1) throw new Error("Incompatible broker protocol");
                    if (p.event === "changed" && typeof p.roomId === "string") {
                        try { this.onChanged?.(p.roomId); } catch { /* consumer failure must not corrupt transport */ }
                        continue;
                    }
                    if (typeof p.id !== "string" || typeof p.ok !== "boolean" ||
                        (p.ok ? !("result" in p) : typeof object(p.error).message !== "string" || typeof object(p.error).code !== "string")) {
                        throw new Error("Malformed broker response");
                    }
                    const response = p as unknown as Response;
                    const entry = this.pending.get(response.id);
                    if (!entry) continue;
                    this.pending.delete(response.id); entry.cleanup();
                    if (response.ok) entry.resolve(response.result);
                    else entry.reject(new TeamError(response.error.code, response.error.message));
                }
            } catch { this.failAll("Invalid broker response; acceptance may be unknown. Check compatible versions."); socket.destroy(); }
        });
        socket.on("error", () => { /* close rejects all requests */ });
        socket.on("close", () => {
            this.closed = true;
            this.failAll("Broker disconnected; acceptance may be unknown. Retry sends only with the same idempotency key.");
            try { this.onClose?.(); } catch { /* no uncaught consumer error */ }
        });
    }
    private failAll(message: string) {
        for (const item of this.pending.values()) { item.cleanup(); item.reject(new TeamError("UNKNOWN", message)); }
        this.pending.clear();
    }
    static connect(socketPath: string, hello: WorkerHello, timeoutMs = 3000, signal?: AbortSignal): Promise<TeamClient<WorkerOperations>> {
        return TeamClient.connectAs<WorkerOperations>(socketPath, hello, timeoutMs, signal);
    }
    /** Internal host connection; never register this credential-bearing surface as an agent tool. */
    static connectControl(socketPath: string, control: string, timeoutMs = 3000): Promise<TeamClient<ControlOperations>> {
        return TeamClient.connectAs<ControlOperations>(socketPath, { control }, timeoutMs);
    }
    private static async connectAs<Ops>(socketPath: string, hello: Params, timeoutMs: number, signal?: AbortSignal): Promise<TeamClient<Ops>> {
        if (signal?.aborted) throw new TeamError("ABORTED", "Connection cancelled before opening.");
        const socket = createConnection({ path: socketPath, signal });
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { socket.destroy(); reject(new TeamError("UNAVAILABLE", "Broker connection timed out. Endpoint preserved; local work can continue.")); }, timeoutMs);
            socket.once("error", (error) => { clearTimeout(timer); reject(Object.assign(new TeamError("UNAVAILABLE", `Broker unavailable (${(error as NodeJS.ErrnoException).code ?? "connection error"}).`), { cause: error })); });
            socket.once("connect", () => { clearTimeout(timer); resolve(); });
        });
        const client = new TeamClient<Ops>(socket, timeoutMs);
        try { await client.rawCall("hello", hello); return client; }
        catch (error) { await client.close(); throw error; }
    }
    call<Name extends keyof Operations & string, Parameters extends OperationParams<Operations, Name>>(op: Name, params: Parameters, signal?: AbortSignal): Promise<CallResult<Operations, Name, Parameters>>;
    call(op: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
        return this.rawCall(op, params as Params, signal);
    }
    private rawCall<T = unknown>(op: string, params: Params, signal?: AbortSignal): Promise<T> {
        if (signal?.aborted) return Promise.reject(new TeamError("ABORTED", "Cancelled before request was sent."));
        if (this.closed || this.socket.destroyed) return Promise.reject(new TeamError("UNAVAILABLE", "Broker is disconnected."));
        const req = request(op, params);
        let bytes: Buffer;
        try { bytes = encode(req); } catch (error) { return Promise.reject(error); }
        return new Promise<T>((resolve, reject) => {
            const abandon = (reason: string) => {
                this.pending.get(req.id)?.cleanup(); this.pending.delete(req.id);
                reject(new TeamError("UNKNOWN", `${reason}; ${op} acceptance may be unknown. Retry sends only with the same idempotency key.`));
            };
            const timer = setTimeout(() => { abandon("Broker response timed out"); this.socket.destroy(); }, this.timeoutMs);
            const onAbort = () => abandon("Request wait cancelled");
            const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
            this.pending.set(req.id, { resolve: (value) => resolve(value as T), reject, cleanup });
            signal?.addEventListener("abort", onAbort, { once: true });
            this.socket.write(bytes);
        });
    }
    close(): Promise<void> {
        this.onChanged = undefined; this.onClose = undefined;
        if (this.closed) return Promise.resolve();
        return new Promise((resolve) => { this.socket.once("close", resolve); this.socket.destroy(); });
    }
}
export async function controlCall<Name extends keyof ControlOperations & string>(paths: TeamPaths, op: Name, params: OperationParams<ControlOperations, Name>): Promise<OperationResult<ControlOperations, Name>> {
    const control = await readControl(paths);
    const client = await TeamClient.connectControl(paths.socket, control);
    try { return await client.call(op, params) as OperationResult<ControlOperations, Name>; } finally { await client.close(); }
}
