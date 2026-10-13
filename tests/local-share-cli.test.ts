import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import localShare from "../extensions/productivity/local-share.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
    vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "local-share-cli-")); roots.push(root);
    const agentDir = path.join(root, "agent"); vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const sessionFile = path.join(root, "synthetic session.jsonl");
    const packageRoot = new URL("../node_modules/@earendil-works/pi-coding-agent/", import.meta.url);
    const manifest = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8"));
    // Run the installed package's declared bin, not a private exporter or an ambient managed installation.
    const cli = fileURLToPath(new URL(manifest.bin.pi, packageRoot));
    const notices: { text: string; level: string }[] = [];
    let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    const exec = vi.fn<ExtensionAPI["exec"]>(async (command, args, options) => {
        expect(command).toBe("pi");
        // Whitelist only test-owned environment: never inherit live session IDs, credentials,
        // user-agent dirs, NODE_OPTIONS, or provider settings. Export has no agent/network work.
        const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root,
            PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", TERM: "dumb" };
        try {
            const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], {
                cwd: options?.cwd, env, encoding: "utf8", timeout: 10_000,
            });
            return { stdout, stderr, code: 0, killed: false };
        } catch (error) {
            const e = error as Error & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
            return { stdout: e.stdout ?? "", stderr: e.stderr ?? e.message, code: typeof e.code === "number" ? e.code : 1, killed: e.killed ?? false };
        }
    });
    localShare({ exec, registerCommand: (_name: string, definition: any) => { handler = definition.handler; } } as unknown as ExtensionAPI);
    const ctx = { cwd: root, waitForIdle: async () => {}, sessionManager: {
        getSessionFile: () => sessionFile, getSessionId: () => "synthetic-id",
        getLeafId: () => "a1", // Live selection differs from the persisted file's final entry.
        getEntries: () => { throw new Error("Do not inspect live transcript entries"); },
    }, ui: { notify: (text: string, level: string) => notices.push({ text, level }) } } as unknown as ExtensionCommandContext;
    return { root, sessionFile, exec, notices, run: async (args: string) => { await handler!(args, ctx); } };
}

it("exports a complete synthetic persisted tree through Pi's public CLI, with its file-selected leaf", async () => {
    const f = await fixture(); const stamp = "2026-10-13T00:00:00.000Z";
    const entries = [
        { type: "session", version: 3, id: "synthetic-id", timestamp: stamp, cwd: f.root },
        { type: "message", id: "u1", parentId: null, timestamp: stamp, message: { role: "user", content: [{ type: "text", text: "Original branch" }], timestamp: 0 } },
        { type: "message", id: "a1", parentId: "u1", timestamp: stamp, message: { role: "assistant", content: [{ type: "text", text: "Original response" }], timestamp: 0,
            api: "anthropic-messages", provider: "synthetic-provider", model: "synthetic-model", stopReason: "stop",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
        { type: "message", id: "alt1", parentId: "u1", timestamp: stamp, message: { role: "user", content: [{ type: "text", text: "Alternative branch café" }], timestamp: 0 } },
    ];
    const bytes = entries.map(entry => JSON.stringify(entry)).join("\n") + "\n"; await writeFile(f.sessionFile, bytes);
    const destination = path.join(f.root, "nested exports", "transcript café #1.html"); await f.run(destination);
    expect(f.notices.at(-1)).toMatchObject({ level: "info", text: expect.stringContaining("Local transcript created:") });
    const html = await readFile(destination, "utf8"); expect(html.toLowerCase()).toContain("<!doctype html>");
    const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
    expect(encoded).toBeDefined();
    const data = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8"));
    expect(data.header.id).toBe("synthetic-id"); expect(data.entries.map((entry: { id: string }) => entry.id)).toEqual(["u1", "a1", "alt1"]);
    expect(data.leafId).toBe("alt1"); expect(data.entries.at(-1).message.content[0].text).toBe("Alternative branch café");
    expect(await readFile(f.sessionFile, "utf8")).toBe(bytes); expect(f.exec).toHaveBeenCalledOnce();
}, 15_000);

it("reports an actual CLI failure for a missing synthetic source without announcing an export", async () => {
    const f = await fixture(); await f.run("missing-source.html");
    expect(f.notices.at(-1)).toMatchObject({ level: "error", text: expect.stringContaining("exited with code 1") });
    expect(f.notices.at(-1)?.text).toContain("File not found"); expect(f.notices.at(-1)?.text).not.toContain("Local transcript created:");
    expect(f.exec).toHaveBeenCalledOnce();
}, 15_000);
