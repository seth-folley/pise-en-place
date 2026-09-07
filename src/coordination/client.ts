import { createConnection, type Socket } from "node:net";
import { encode, Frames, object, request, TeamError, type Params, type Response } from "./protocol.ts";
import { readControl, type TeamPaths } from "./paths.ts";

export class TeamClient {
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
    static async connect(socketPath: string, hello: Params, timeoutMs = 3000, signal?: AbortSignal): Promise<TeamClient> {
        if (signal?.aborted) throw new TeamError("ABORTED", "Connection cancelled before opening.");
        const socket = createConnection({ path: socketPath, signal });
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { socket.destroy(); reject(new TeamError("UNAVAILABLE", "Broker connection timed out. Endpoint preserved; local work can continue.")); }, timeoutMs);
            socket.once("error", (error) => { clearTimeout(timer); reject(Object.assign(new TeamError("UNAVAILABLE", `Broker unavailable (${(error as NodeJS.ErrnoException).code ?? "connection error"}).`), { cause: error })); });
            socket.once("connect", () => { clearTimeout(timer); resolve(); });
        });
        const client = new TeamClient(socket, timeoutMs);
        try { await client.call("hello", hello); return client; }
        catch (error) { await client.close(); throw error; }
    }
    call<T = unknown>(op: string, params: Params, signal?: AbortSignal): Promise<T> {
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
export async function controlCall<T = unknown>(paths: TeamPaths, op: string, params: Params): Promise<T> {
    const control = await readControl(paths);
    const client = await TeamClient.connect(paths.socket, { control });
    try { return await client.call<T>(op, params); } finally { await client.close(); }
}
