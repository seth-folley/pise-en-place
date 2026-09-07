import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { startupGate, recoverSocket } from "./startup.ts";
import { startBroker } from "./broker.ts";
import { controlCall } from "./client.ts";
import { teamPaths, privatePath } from "./paths.ts";

function notifyParent(message: unknown): void {
    if (process.connected) process.send?.(message, () => { /* Parent may exit during startup; idle shutdown still applies. */ });
}
async function main() {
    const paths = teamPaths();
    const [command = "help", argument] = process.argv.slice(2);
    if (command === "start" || command === "managed-start") {
        const managed = command === "managed-start";
        let broker;
        try { broker = await startBroker(paths, { recover: true, ...(managed ? { idleMs: 60_000 } : {}) }); }
        catch (e) {
            if (!managed || (e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
            await controlCall(paths, "health", {});
            notifyParent({ ready: true }); return;
        }
        if (managed) notifyParent({ ready: true });
        else console.log(`Coordination broker ready (protocol/schema 1)\nSocket: ${paths.socket}\nDatabase: ${paths.database}\nNo model calls; Ctrl+C stops the broker and preserves history.`);
        const stop = () => { void broker.stop().catch((e) => { console.error(e.message); process.exitCode = 1; }); };
        process.once("SIGINT", stop); process.once("SIGTERM", stop);
        return;
    }
    if (command === "health" || command === "stop") {
        console.log(JSON.stringify(await controlCall(paths, command, {}), null, 2)); return;
    }
    if (command === "cleanup") {
        await startupGate(paths, () => recoverSocket(paths));
        console.log("Stale socket cleanup completed. Database preserved."); return;
    }
    if (command === "backup" && argument) {
        await privatePath(paths.database);
        const destination = resolve(argument);
        await writeFile(destination, "", { flag: "wx", mode: 0o600 });
        const db = new DatabaseSync(paths.database, { readOnly: true });
        try { await backup(db, destination); } finally { db.close(); }
        console.log(`Consistent SQLite backup: ${destination}`); return;
    }
    console.log("Optional maintenance: npm run team:broker -- start|health|stop|cleanup|backup <new-path>\nNormal use: /team join starts/reuses the broker automatically. No service installation or manual teardown required.");
    if (command !== "help") process.exitCode = 1;
}
void main().catch((error: NodeJS.ErrnoException) => {
    notifyParent({ error: error.message });
    console.error(error.code === "EADDRINUSE" ? "Broker already running. History was not reset." : error.message);
    process.exitCode = 1;
});
