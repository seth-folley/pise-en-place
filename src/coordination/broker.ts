import { chmod, lstat, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { startupGate, recoverSocket } from "./startup.ts";
import { TeamStore, secretMatches } from "./store.ts";
import { preparePaths, privatePath, type TeamPaths } from "./paths.ts";
import { ACTIVATION_POLICY_VERSION, encode, fail, fields, Frames, parseRequest, SCHEMA_VERSION, TeamError, text, type Actor } from "./protocol.ts";

export interface RunningBroker { store: TeamStore; stop(): Promise<void> }
/** Bind before opening the DB: a competing broker cannot reset the live owner's leases. */
export function startBroker(paths: TeamPaths, options: { now?: () => number; sweepMs?: number; idleMs?: number; recover?: boolean } = {}): Promise<RunningBroker> {
    return startupGate(paths, async () => {
        if (options.recover) await recoverSocket(paths);
        return bindBroker(paths, options);
    });
}
async function bindBroker(paths: TeamPaths, options: { now?: () => number; sweepMs?: number; idleMs?: number }): Promise<RunningBroker> {
    let lastActivity = Date.now();
    const control = await preparePaths(paths);
    const clients = new Map<Socket, Actor | undefined>();
    let store: TeamStore | undefined;
    let stopping: Promise<void> | undefined;
    let sweep: ReturnType<typeof setInterval> | undefined;
    let changedRooms = new Set<string>();
    let pendingHint: ReturnType<typeof setTimeout> | undefined;
    const send = (socket: Socket, value: unknown) => {
        if (socket.destroyed) return;
        if (socket.writableLength > 512 * 1024) { socket.destroy(); return; }
        socket.write(encode(value));
    };
    const changed = (roomId: string) => {
        changedRooms.add(roomId);
        if (pendingHint) return;
        pendingHint = setTimeout(() => {
            pendingHint = undefined;
            const rooms = changedRooms; changedRooms = new Set();
            for (const [socket, actor] of clients) if (actor?.kind === "worker" && rooms.has(actor.roomId)) {
                try {
                    // Revalidate subscriptions after leave, expiry or rebind before exposing events.
                    store?.dispatch(actor, "status", { roomId: actor.roomId });
                    send(socket, { v: 1, event: "changed", roomId: actor.roomId });
                } catch { socket.destroy(); }
            }
        }, 25);
        pendingHint.unref();
    };
    const server: Server = createServer((socket) => {
        const connectionId = randomUUID();
        clients.set(socket, undefined); lastActivity = Date.now();
        const frames = new Frames();
        const handshakeDeadline = setTimeout(() => socket.destroy(), 5000);
        handshakeDeadline.unref();
        let windowStart = Date.now(), count = 0;
        socket.on("error", () => { /* close cleans up; never crash Pi or broker */ });
        socket.on("close", () => {
            clearTimeout(handshakeDeadline);
            const actor = clients.get(socket); clients.delete(socket); lastActivity = Date.now();
            if (actor?.kind === "worker" && store && !stopping) {
                try { store.disconnect(actor); changed(actor.roomId); } catch { /* expired/closed store; lease recovery handles it */ }
            }
        });
        socket.on("data", (bytes) => {
            lastActivity = Date.now();
            try {
                for (const value of frames.push(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))) {
                    if (Date.now() - windowStart > 1000) { windowStart = Date.now(); count = 0; }
                    if (++count > 100) fail("RATE", "Too many requests on one connection.");
                    const req = parseRequest(value);
                    try {
                        if (!store) fail("STARTING", "Broker is starting; retry shortly.");
                        let actor = clients.get(socket);
                        let result: unknown;
                        if (!actor) {
                            if (req.op !== "hello") fail("AUTH", "Authenticate before using coordination.");
                            if (req.params.control !== undefined) {
                                fields(req.params, ["control"]);
                                if (!secretMatches(text(req.params, "control", 100), control)) fail("AUTH", "Invalid control credential.");
                                actor = { kind: "control" };
                            } else actor = store.connect(req.params, connectionId);
                            clients.set(socket, actor); clearTimeout(handshakeDeadline);
                            result = { protocol: 1, generation: actor.kind === "worker" ? actor.generation : undefined };
                            if (actor.kind === "worker") changed(actor.roomId);
                        } else if (["join", "restore", "health", "stop"].includes(req.op)) {
                            if (actor.kind !== "control") fail("FORBIDDEN", "Explicit human control required.");
                            if (req.op === "join" || req.op === "restore") {
                                result = store.enroll(req.params, req.op === "restore");
                                changed((result as { roomId: string }).roomId);
                            } else {
                                fields(req.params, []);
                                result = { protocol: 1, schema: SCHEMA_VERSION, activationPolicy: ACTIVATION_POLICY_VERSION, status: req.op === "stop" ? "stopping" : "healthy" };
                                if (req.op === "stop") setTimeout(() => { void stop(); }, 30);
                            }
                        } else {
                            result = store.dispatch(actor, req.op, req.params);
                            if (!["status", "read", "heartbeat"].includes(req.op) && !(req.op === "auto-reserve" && result === null)) changed(text(req.params, "roomId"));
                            // Runtime presence changes are seen within the 5s client refresh cycle.
                        }
                        send(socket, { v: 1, id: req.id, ok: true, result });
                    } catch (error) {
                        const e = error instanceof TeamError ? error : new TeamError("STORAGE", "Broker operation failed. Inspect storage/permissions; acceptance may be unknown. Retry sends only with the same idempotency key.");
                        send(socket, { v: 1, id: req.id, ok: false, error: { code: e.code, message: e.message } });
                        if (["AUTH", "STALE"].includes(e.code)) socket.end();
                    }
                }
            } catch { socket.destroy(); }
        });
    });
    const stop = (): Promise<void> => {
        if (stopping) return stopping;
        stopping = (async () => {
            if (sweep) clearInterval(sweep);
            if (pendingHint) clearTimeout(pendingHint);
            for (const [socket, actor] of clients) {
                if (store && actor?.kind === "worker") { try { store.disconnect(actor); } catch { /* still close */ } }
                socket.destroy();
            }
            await new Promise<void>((resolve) => server.close(() => resolve()));
            store?.close(); store = undefined;
        })();
        return stopping;
    };
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(paths.socket, () => { server.removeListener("error", reject); resolve(); });
    });
    server.on("error", () => { void stop(); });
    try {
        await chmod(paths.socket, 0o600);
        try { await writeFile(paths.database, "", { flag: "wx", mode: 0o600 }); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
        await privatePath(paths.database);
        for (const suffix of ["-wal", "-shm"]) {
            try { await lstat(paths.database + suffix); await privatePath(paths.database + suffix); }
            catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        }
        store = new TeamStore(paths.database, options.now);
        sweep = setInterval(() => {
            try {
                for (const room of store?.expire() ?? []) changed(room);
                if (options.idleMs && clients.size === 0 && Date.now() - lastActivity >= options.idleMs) void stop();
            }
            catch { void stop(); } // Can't enforce leases if storage fails; fail closed.
        }, options.sweepMs ?? 1000);
        sweep.unref();
        return { store, stop };
    } catch (e) { await stop(); throw e; }
}
