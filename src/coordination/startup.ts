import { lstat, mkdir, unlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { privatePath, type TeamPaths } from "./paths.ts";

/** A short SQLite write transaction serializes bind/recovery across processes.
 * Kernel locks disappear on crash; no PID guessing, stale lock stealing, or shared agent state file.
 * Never delete this gate file while brokers/startups may exist.
 */
export async function startupGate<T>(paths: TeamPaths, action: () => Promise<T>): Promise<T> {
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    await privatePath(paths.directory, true);
    const path = join(paths.directory, "startup.sqlite");
    try { await writeFile(path, "", { flag: "wx", mode: 0o600 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    await privatePath(path);
    const db = new DatabaseSync(path);
    const deadline = Date.now() + 10_000;
    try {
        db.exec("PRAGMA busy_timeout=0");
        for (;;) {
            try { db.exec("BEGIN IMMEDIATE"); break; }
            catch (e) {
                if ((e as { errcode?: number }).errcode !== 5 || Date.now() >= deadline) throw e;
                await new Promise((resolve) => setTimeout(resolve, 30));
            }
        }
        try { return await action(); } finally { db.exec("ROLLBACK"); }
    } finally { db.close(); }
}

/** Must run inside startupGate. Only ECONNREFUSED proves a stale endpoint. */
export async function recoverSocket(paths: TeamPaths): Promise<void> {
    let before;
    try { before = await lstat(paths.socket); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    if (!before.isSocket() || (process.getuid && before.uid !== process.getuid())) throw new Error("Refusing unsafe broker socket path.");
    const live = await new Promise<boolean>((resolve, reject) => {
        const socket = createConnection(paths.socket);
        const timer = setTimeout(() => { socket.destroy(); reject(new Error("Broker probe timed out; endpoint preserved.")); }, 1000);
        socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
        socket.once("error", (e: NodeJS.ErrnoException) => {
            clearTimeout(timer); socket.destroy();
            if (e.code === "ECONNREFUSED") resolve(false); else reject(e);
        });
    });
    if (live) throw Object.assign(new Error("Broker already running."), { code: "EADDRINUSE" });
    const after = await lstat(paths.socket);
    if (before.ino !== after.ino || before.dev !== after.dev) throw new Error("Broker endpoint changed; refusing recovery.");
    await unlink(paths.socket);
}
