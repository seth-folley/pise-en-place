import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { controlCall } from "../../src/coordination/client.ts";
import { teamPaths } from "../../src/coordination/paths.ts";

const exec = promisify(execFile);
it("runs the packaged CLI as a separate process and exchanges messages between independent fake-client processes", async () => {
    const root = await mkdtemp("/tmp/pi-team-cli-");
    const paths = teamPaths(root), env = { ...process.env, PI_CODING_AGENT_DIR: root };
    const cli = resolve("src/coordination/cli.ts");
    const processHandle = spawn(process.execPath, ["--import", "tsx", cli, "start"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; processHandle.stderr.on("data", (b) => { stderr += b; });
    const run = (script: string) => exec(process.execPath, ["--import", "tsx", "-e", script], { env, timeout: 10_000 });
    const prelude = `const {controlCall,TeamClient}=require(${JSON.stringify(resolve("src/coordination/client.ts"))});
const {teamPaths}=require(${JSON.stringify(resolve("src/coordination/paths.ts"))});
const paths=teamPaths();
const connect=(c)=>TeamClient.connect(paths.socket,{roomId:c.roomId,participantId:c.participantId,sessionId:c.sessionId,token:c.token});`;
    try {
        await expect.poll(async () => {
            if (processHandle.exitCode !== null) throw new Error(stderr || "Broker exited early");
            return controlCall(paths, "health", {}).catch(() => null);
        }, { timeout: 10_000 }).toMatchObject({ status: "healthy" });
        // Backend enrolls in a different process, then exits: sender must report offline pending, not delivered.
        await run(`${prelude}(async()=>{await controlCall(paths,'join',{room:'catalog',name:'backend',role:'worker',sessionId:'backend-session'});})().catch(e=>{console.error(e);process.exitCode=1});`);
        const { stdout } = await run(`${prelude}(async()=>{
 const a=await controlCall(paths,'join',{room:'catalog',name:'app',role:'worker',sessionId:'app-session'});
 const client=await connect(a);try {
 const s=await client.call('status',{roomId:a.roomId});const b=s.participants.find(p=>p.name==='backend');
 const m=await client.call('send',{roomId:a.roomId,idempotencyKey:'q',recipients:[b.id],type:'question',subject:'Null?',body:'Can flight numbers be null?'});
 console.log(JSON.stringify({id:m.id,state:m.deliveries[0].state,presence:m.deliveries[0].presence}));
 }finally{await client.close()}
})().catch(e=>{console.error(e);process.exitCode=1});`);
        expect(JSON.parse(stdout)).toMatchObject({ state: "pending", presence: "disconnected" });
        const { stdout: reply } = await run(`${prelude}(async()=>{
 const b=await controlCall(paths,'join',{room:'catalog',name:'backend',role:'worker',sessionId:'backend-session',rejoin:true});
 const client=await connect(b);try {
 const page=await client.call('read',{roomId:b.roomId}); const q=page.items[0];
 const m=await client.call('send',{roomId:b.roomId,idempotencyKey:'r',recipients:[q.sender_id],type:'reply',threadId:q.thread_id,replyTo:q.id,body:'Yes, null means unknown.'});
 console.log(JSON.stringify({sequence:m.sequence,body:m.body}));
 }finally{await client.close()}
})().catch(e=>{console.error(e);process.exitCode=1});`);
        expect(JSON.parse(reply)).toEqual({ sequence: 2, body: "Yes, null means unknown." });
        const backup = `${root}/backup.sqlite`;
        await exec(process.execPath, ["--import", "tsx", cli, "backup", backup], { env, timeout: 10_000 });
        expect((await stat(backup)).mode & 0o077).toBe(0);
        const db = new DatabaseSync(backup, { readOnly: true });
        try { expect(db.prepare("SELECT count(*) n FROM messages").get()?.n).toBe(2); } finally { db.close(); }
        const exited = once(processHandle, "exit");
        await exec(process.execPath, ["--import", "tsx", cli, "stop"], { env, timeout: 10_000 });
        await exited; expect(processHandle.exitCode).toBe(0);
    } finally {
        if (processHandle.exitCode === null) { const exit = once(processHandle, "exit"); processHandle.kill("SIGTERM"); await exit; }
        await rm(root, { recursive: true, force: true });
    }
}, 30_000);
