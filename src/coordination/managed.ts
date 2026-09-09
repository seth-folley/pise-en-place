import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { ACTIVATION_POLICY_VERSION, SCHEMA_VERSION } from "./protocol.ts";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { startupGate } from "./startup.ts";
import { controlCall } from "./client.ts";
import { type TeamPaths } from "./paths.ts";

const starting = new Map<string, Promise<void>>();
/** Called only for explicit enrollment/restoration or reconnect of an enrolled session. */
export function ensureBroker(paths: TeamPaths): Promise<void> {
    const existing = starting.get(paths.socket);
    if (existing) return existing;
    const ready = ensure(paths).finally(() => starting.delete(paths.socket));
    starting.set(paths.socket, ready);
    return ready;
}
async function ensure(paths: TeamPaths): Promise<void> {
    // Do not inspect a half-written key or a bound-but-not-yet-initialized broker.
    try {
        const ready = await startupGate(paths, async () => {
            const health = await controlCall(paths, "health", {});
            if (health.protocol !== 1 || health.status !== "healthy") throw new Error("Incompatible broker health response; endpoint preserved.");
            if (health.schema !== 1 && health.schema !== SCHEMA_VERSION) throw new Error("Unsupported broker schema; endpoint preserved. Update broker and extension together.");
            const policy = health.activationPolicy ?? 1;
            if (![1, 2, ACTIVATION_POLICY_VERSION].includes(policy)) throw new Error("Unsupported broker activation policy; endpoint preserved.");
            if (health.schema === SCHEMA_VERSION && policy === ACTIVATION_POLICY_VERSION) return true;
            // Known schema/policy upgrade: graceful replacement preserves the activation ledger.
            // In-flight uncertain runs retain their normal conservative pause/recovery behavior.
            // No database/key deletion; existing clients reconnect with their same credentials.
            await controlCall(paths, "stop", {});
            const deadline = Date.now() + 3000;
            for (;;) {
                try { await lstat(paths.socket); }
                catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
                if (Date.now() >= deadline) throw new Error("Previous broker did not stop for upgrade; endpoint preserved.");
                await new Promise((r) => setTimeout(r, 30));
            }
        });
        if (ready) return;
    }
    catch (e) {
        // Never replace a live but incompatible, unauthenticated, slow, or unhealthy endpoint.
        const error = e as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException };
        if (!["ENOENT", "ECONNREFUSED"].includes(error.cause?.code ?? error.code ?? "")) throw e;
    }
    const require = createRequire(join(__dirname, "managed.ts"));
    const runner = require.resolve("tsx/cli");
    await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [runner, join(__dirname, "cli.ts"), "managed-start"], {
            detached: true,
            // The broker needs no provider keys, prompts, or inherited Node preload hooks.
            env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
                LANG: process.env.LANG, PI_CODING_AGENT_DIR: dirname(paths.directory) },
            stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        let errors = "", settled = false;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true; clearTimeout(timer);
            if (child.connected) child.disconnect();
            child.stderr?.destroy(); child.unref();
            if (error) reject(error); else resolve();
        };
        const timer = setTimeout(() => finish(new Error("Team broker startup timed out. Local work can continue; retry joining.")), 15_000);
        child.stderr?.on("data", (chunk) => { errors = (errors + chunk.toString()).slice(-4096); });
        child.on("error", (e) => finish(e));
        child.on("exit", (code) => finish(new Error(`Team broker could not start (${code}): ${errors || "no readiness response"}`)));
        child.on("message", (message: unknown) => {
            if (typeof message !== "object" || !message) return;
            const m = message as { ready?: boolean; error?: string };
            if (m.ready === true) finish();
            else if (typeof m.error === "string") finish(new Error(`Team broker could not start: ${m.error}`));
        });
    });
}
