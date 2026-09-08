import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { Frames, encode } from "../../src/coordination/protocol.ts";
import { mkdtemp, rm, lstat, mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ensureBroker } from "../../src/coordination/managed.ts";
import { startBroker } from "../../src/coordination/broker.ts";
import { controlCall, TeamClient } from "../../src/coordination/client.ts";
import { preparePaths, teamPaths } from "../../src/coordination/paths.ts";
import type { Credential, Status } from "../../src/coordination/protocol.ts";
const exec = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup() {
    const root = await mkdtemp("/tmp/pi-auto-");
    const paths = teamPaths(root);
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    cleanup.push(async () => {
        await controlCall(paths, "stop", {}).catch(() => {});
        await expect.poll(async () => { try { await lstat(paths.socket); return true; } catch { return false; } }).toBe(false);
    });
    return { root, paths };
}
it.each([1, 2, 99])("upgrades known schema/policy brokers but preserves unknown versions (%i)", async (schema) => {
    const { paths } = await setup();
    const key = await preparePaths(paths); let stops = 0;
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
        sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
        const frames = new Frames();
        socket.on("data", (bytes) => {
            for (const value of frames.push(Buffer.from(bytes))) {
                const req = value as { id: string; op: string };
                socket.write(encode({ v: 1, id: req.id, ok: true, result: { protocol: 1, schema, status: req.op === "stop" ? "stopping" : "healthy" } }));
                if (req.op === "stop") { stops++; setTimeout(() => { server.close(); for (const s of sockets) s.destroy(); }, 30); }
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(paths.socket, resolve));
    cleanup.push(async () => { if (server.listening) { for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); } });
    if (schema === 1 || schema === 2) {
        await ensureBroker(paths); expect(stops).toBe(1);
        expect(await controlCall(paths, "health", {})).toMatchObject({ schema: 2, activationPolicy: 2 });
        expect((await readFile(paths.control, "utf8")).trim()).toBe(key);
    } else {
        await expect(ensureBroker(paths)).rejects.toThrow(/Unsupported broker schema/);
        expect(stops).toBe(0); expect(server.listening).toBe(true);
    }
}, 20_000);
it("cold-starts once across independent callers, reuses live identity, and needs no npm process", async () => {
    const { root, paths } = await setup();
    const script = `const {ensureBroker}=require(${JSON.stringify(resolve("src/coordination/managed.ts"))});const {teamPaths}=require(${JSON.stringify(resolve("src/coordination/paths.ts"))});ensureBroker(teamPaths()).catch(e=>{console.error(e);process.exitCode=1});`;
    await Promise.all(Array.from({ length: 4 }, () => exec(process.execPath, ["--import", "tsx", "-e", script], { env: { ...process.env, PI_CODING_AGENT_DIR: root }, timeout: 20_000 })));
    const c = await controlCall<Credential>(paths, "join", { room: "catalog", name: "app", role: "worker", sessionId: "app" });
    const client = await TeamClient.connect(paths.socket, { roomId: c.roomId, participantId: c.participantId, sessionId: c.sessionId, token: c.token });
    cleanup.push(() => client.close());
    await ensureBroker(paths);
    expect((await client.call<Status>("status", { roomId: c.roomId })).participants[0].presence).toBe("connected");
}, 30_000);
it("reports unsafe startup paths without overwriting them or resetting storage", async () => {
    const { paths } = await setup();
    await mkdir(paths.directory, { mode: 0o700 });
    await writeFile(paths.socket, "not a socket", { mode: 0o600 });
    try {
        await expect(ensureBroker(paths)).rejects.toThrow(/unsafe broker socket/);
        expect(await readFile(paths.socket, "utf8")).toBe("not a socket");
        await expect(lstat(paths.database)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await unlink(paths.socket); }
});
it("recovers a SIGKILL stale socket automatically without losing room identity", async () => {
    const { root, paths } = await setup();
    const child = spawn(process.execPath, ["--import", "tsx", resolve("src/coordination/cli.ts"), "start"], { env: { ...process.env, PI_CODING_AGENT_DIR: root }, stdio: "ignore" });
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGKILL"); await exit; } });
    await expect.poll(() => controlCall(paths, "health", {}).catch(() => null)).toMatchObject({ status: "healthy" });
    const c = await controlCall<Credential>(paths, "join", { room: "catalog", name: "backend", role: "worker", sessionId: "backend" });
    const exit = once(child, "exit"); child.kill("SIGKILL"); await exit;
    expect((await lstat(paths.socket)).isSocket()).toBe(true);
    await ensureBroker(paths);
    const restored = await controlCall<Credential>(paths, "join", { room: "catalog", name: "backend", role: "worker", sessionId: "backend", rejoin: true });
    expect(restored.participantId).toBe(c.participantId); expect(restored.roomId).toBe(c.roomId);
}, 20_000);
it("keeps idle connected agents alive, then shuts down without deleting durable history", async () => {
    const { paths } = await setup();
    const broker = await startBroker(paths, { idleMs: 100, sweepMs: 10 }); cleanup.push(() => broker.stop());
    const c = await controlCall<Credential>(paths, "join", { room: "catalog", name: "app", role: "worker", sessionId: "app" });
    const client = await TeamClient.connect(paths.socket, { roomId: c.roomId, participantId: c.participantId, sessionId: c.sessionId, token: c.token }); cleanup.push(() => client.close());
    await new Promise((r) => setTimeout(r, 180));
    expect((await client.call<Status>("status", { roomId: c.roomId })).participants[0].presence).toBe("connected");
    await client.close();
    await expect.poll(async () => { try { await lstat(paths.socket); return true; } catch { return false; } }).toBe(false);
    await ensureBroker(paths);
    expect((await controlCall<Credential>(paths, "join", { room: "catalog", name: "app", role: "worker", sessionId: "app", rejoin: true })).participantId).toBe(c.participantId);
}, 20_000);
