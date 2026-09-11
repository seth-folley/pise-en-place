import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startBroker, type RunningBroker } from "../../src/coordination/broker.ts";
import { TeamClient, controlCall } from "../../src/coordination/client.ts";
import { teamPaths } from "../../src/coordination/paths.ts";
import { Frames, MAX_FRAME_BYTES, encode, type Credential, type Message, type Page, type Status } from "../../src/coordination/protocol.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const workerHello = (c: Credential) => ({ roomId: c.roomId, participantId: c.participantId, sessionId: c.sessionId, token: c.token });
type RawClient = { call(op: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> };
const raw = (client: TeamClient): RawClient => client as unknown as RawClient;
const connectRaw = TeamClient.connect as unknown as (path: string, hello: Record<string, unknown>, timeoutMs?: number) => Promise<TeamClient>;
async function setup() {
    // Short /tmp path is deliberate: macOS Unix sockets have a ~104-byte path limit.
    const dir = await mkdtemp("/tmp/pi-team-net-"); cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const paths = teamPaths(dir);
    let broker: RunningBroker = await startBroker(paths);
    cleanups.push(async () => broker.stop());
    const joinRoom = (name: string, room = "catalog") => controlCall(paths, "join", { room, name, role: "worker", sessionId: `${name}-${room}` });
    const connect = async (c: Credential) => {
        const client = await TeamClient.connect(paths.socket, workerHello(c)); cleanups.push(() => client.close()); return client;
    };
    return { paths, joinRoom, connect, get broker() { return broker; }, async restart() { await broker.stop(); broker = await startBroker(paths); } };
}

describe("LF protocol", () => {
    it("handles fragmented multibyte strings and coalesced frames without splitting Unicode separators", () => {
        const value = { text: "é🌱\u2028next\nline" }; const bytes = Buffer.concat([encode(value), encode({ ok: true })]);
        const frames = new Frames(), result: unknown[] = [];
        for (const byte of bytes) result.push(...frames.push(Buffer.from([byte])));
        expect(result).toEqual([value, { ok: true }]);
    });
    it("rejects malformed UTF-8, JSON and oversized frames before unbounded buffering", () => {
        expect(() => new Frames().push(Buffer.from("not json\n"))).toThrow(/Malformed/);
        expect(() => new Frames().push(Buffer.from([0xff, 10]))).toThrow(/Malformed/);
        expect(() => new Frames().push(Buffer.alloc(MAX_FRAME_BYTES, 65))).toThrow(/limit/);
        expect(() => encode({ data: "x".repeat(MAX_FRAME_BYTES) })).toThrow(/limit/);
    });
});

describe("real Unix socket / SQLite integration", () => {
    it("connects separate rooms and asynchronously exchanges durable questions/replies", async () => {
        const s = await setup(), a = await s.joinRoom("app"), b = await s.joinRoom("backend"), w = await s.joinRoom("app", "website");
        const app = await s.connect(a), backend = await s.connect(b), web = await s.connect(w);
        const hints: string[] = []; backend.onChanged = (room) => hints.push(room);
        const m = await app.call("send", { roomId: a.roomId, idempotencyKey: "q", recipients: [b.participantId], type: "question", subject: "Null?", body: "Can fields be null?" });
        expect(m.author_name).toBe("app"); expect(m.deliveries[0].state).toBe("pending");
        await expect.poll(() => hints).toContain(a.roomId);
        const page = await backend.call("read", { roomId: b.roomId }); expect(page.items[0].id).toBe(m.id);
        await expect(web.call("read", { roomId: a.roomId, messageId: m.id })).rejects.toThrow(/not enrolled/);
        const r = await backend.call("send", { roomId: b.roomId, idempotencyKey: "r", recipients: [a.participantId], type: "reply", threadId: m.thread_id, replyTo: m.id, body: "Yes" });
        expect(r.sequence).toBe(2); expect(r.thread_id).toBe(m.thread_id);
        expect((await web.call("status", { roomId: w.roomId })).participants).toHaveLength(1);
    });
    it("serializes concurrent sends and deduplicates transport retries", async () => {
        const s = await setup(), a = await s.joinRoom("app"), b = await s.joinRoom("backend"), app = await s.connect(a);
        const payload = { roomId: a.roomId, idempotencyKey: "q", recipients: [b.participantId], type: "question" as const, subject: "Question", body: "Hello" };
        const duplicate = await Promise.all(Array.from({ length: 10 }, () => app.call("send", payload)));
        expect(new Set(duplicate.map((m) => m.id)).size).toBe(1);
        const replies = await Promise.all(Array.from({ length: 10 }, (_, i) => app.call("send", { ...payload, idempotencyKey: `m${i}`, type: "status", threadId: duplicate[0].thread_id })));
        expect(replies.map((m) => m.sequence)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    });
    it("retains messages across broker restart and fences duplicate live connections", async () => {
        const s = await setup(), a = await s.joinRoom("app"), b = await s.joinRoom("backend"), app = await s.connect(a);
        await expect(TeamClient.connect(s.paths.socket, workerHello(a))).rejects.toThrow(/live connection/);
        const m = await app.call("send", { roomId: a.roomId, idempotencyKey: "q", recipients: [b.participantId], type: "question", subject: "Offline", body: "Pending" });
        expect(m.deliveries[0].presence).toBe("disconnected");
        await s.restart(); const backend = await s.connect(b);
        expect((await backend.call("read", { roomId: b.roomId })).items[0].id).toBe(m.id);
    });
    it("rejects worker control operations and wrong credentials", async () => {
        const s = await setup(), a = await s.joinRoom("app"), app = await s.connect(a);
        // Deliberately bypass compile-time operation maps to test broker-side runtime authorization.
        await expect(raw(app).call("join", { room: "forged" })).rejects.toThrow(/human control/);
        await expect(raw(app).call("stop", {})).rejects.toThrow(/human control/);
        await expect(connectRaw(s.paths.socket, { control: "forged" })).rejects.toThrow(/credential/);
        await expect(raw(app).call("pause", { roomId: a.roomId, paused: true })).rejects.toThrow(/human control/);
        if (false) {
            // @ts-expect-error Worker clients cannot invoke control operations.
            void app.call("join", { room: "forged" });
            // @ts-expect-error Worker send parameters are checked at compile time.
            void app.call("send", { roomId: a.roomId });
        }
    });
    it("uses private paths and rejects a second broker without resetting the first", async () => {
        const s = await setup(), a = await s.joinRoom("app"), app = await s.connect(a);
        await expect(startBroker(s.paths)).rejects.toMatchObject({ code: "EADDRINUSE" });
        expect((await app.call("status", { roomId: a.roomId })).participants[0].presence).toBe("connected");
        for (const path of [s.paths.database, s.paths.control, s.paths.socket]) expect((await stat(path)).mode & 0o077).toBe(0);
        expect((await stat(s.paths.directory)).mode & 0o777).toBe(0o700);
    });
    it("disconnects malformed/version-mismatched streams without crashing broker", async () => {
        const s = await setup();
        for (const payload of ["{bad}\n", JSON.stringify({ v: 9, id: "bad", op: "hello", params: {} }) + "\n"]) {
            await new Promise<void>((resolve, reject) => {
                const socket = createConnection(s.paths.socket);
                const timeout = setTimeout(() => { socket.destroy(); reject(new Error("Expected socket close")); }, 1000);
                socket.on("error", () => {}); socket.on("close", () => { clearTimeout(timeout); resolve(); });
                socket.on("connect", () => socket.write(payload));
            });
        }
        expect(await controlCall(s.paths, "health", {})).toMatchObject({ status: "healthy" });
    });
    it("reports unavailable broker without false success", async () => {
        await expect(connectRaw(join(tmpdir(), "no-pi-team-socket-here"), {})).rejects.toThrow(/Broker unavailable/);
    });
    it("closes invalid-response connections", async () => {
        const directory = await mkdtemp("/tmp/pi-team-fake-"); cleanups.push(() => rm(directory, { recursive: true, force: true }));
        const path = join(directory, "test.sock");
        const server = createServer((socket) => { socket.on("data", () => socket.write('{"v":1,"id":99}\n')); });
        await new Promise<void>((r) => server.listen(path, r)); cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
        await expect(connectRaw(path, { control: "test" }, 100)).rejects.toThrow(/Invalid broker response/);
    });
    it("bounds request waits and reports unknown acceptance on timeout or mid-request abort", async () => {
        const directory = await mkdtemp("/tmp/pi-team-wait-"); cleanups.push(() => rm(directory, { recursive: true, force: true }));
        const path = join(directory, "test.sock");
        const server = createServer((socket) => {
            const frames = new Frames();
            socket.on("data", (chunk) => {
                for (const value of frames.push(Buffer.from(chunk))) {
                    const req = value as { id: string; op: string };
                    if (req.op === "hello") socket.write(encode({ v: 1, id: req.id, ok: true, result: {} }));
                    // Deliberately never answer subsequent operations.
                }
            });
        });
        await new Promise<void>((r) => server.listen(path, r)); cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
        const timed = await connectRaw(path, { control: "test" }, 100); cleanups.push(() => timed.close());
        await expect(raw(timed).call("send", {})).rejects.toThrow(/timed out.*acceptance may be unknown/);
        const aborted = await connectRaw(path, { control: "test" }, 1000); cleanups.push(() => aborted.close());
        const controller = new AbortController();
        const wait = raw(aborted).call("send", {}, controller.signal); controller.abort();
        await expect(wait).rejects.toThrow(/cancelled.*acceptance may be unknown/);
        await expect(raw(aborted).call("send", {}, controller.signal)).rejects.toThrow(/before request was sent/);
    });
    it("preserves database if startup schema validation fails", async () => {
        const s = await setup(); await s.broker.stop();
        await writeFile(s.paths.database, "not a database");
        await expect(startBroker(s.paths)).rejects.toThrow();
        expect((await stat(s.paths.database)).size).toBe(14);
    });
});
