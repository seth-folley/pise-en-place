import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecResult, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import localShare from "../extensions/productivity/local-share.ts";

const roots: string[] = [];
afterEach(async () => {
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const result = (code = 0, stderr = "", killed = false): ExecResult => ({ code, killed, stderr, stdout: "PRIVATE STDOUT" });
async function harness(run?: (output: string) => Promise<ExecResult>) {
    const root = await mkdtemp(path.join(os.tmpdir(), "local-share-")); roots.push(root);
    const agentDir = path.join(root, "agent"); vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const sessionFile = path.join(root, "session with spaces.jsonl"); await writeFile(sessionFile, "SYNTHETIC SESSION");
    const notices: { text: string; level: string }[] = [];
    let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    const exec = vi.fn<ExtensionAPI["exec"]>(async (_command, args) => {
        const output = args.at(-1)!;
        if (run) return run(output);
        await writeFile(output, "<!doctype html><html>Synthetic transcript</html>"); return result();
    });
    const register = vi.fn((_name: string, definition: any) => { handler = definition.handler; });
    localShare({ exec, registerCommand: register } as unknown as ExtensionAPI);
    const getSessionFile = vi.fn<() => string | undefined>(() => sessionFile);
    const getSessionId = vi.fn(() => "fixture-id");
    const waitForIdle = vi.fn(async () => {});
    const ctx = { cwd: root, waitForIdle, sessionManager: { getSessionFile, getSessionId },
        ui: { notify: (text: string, level: string) => notices.push({ text, level }) } } as unknown as ExtensionCommandContext;
    return { root, agentDir, sessionFile, exec, register, notices, getSessionFile, getSessionId, waitForIdle,
        run: async (args = "") => { await handler!(args, ctx); }, last: () => notices.at(-1)!,
        output: () => exec.mock.calls[0][1].at(-1)! };
}

describe("local transcript export", () => {
    it("keeps the command, default destination, isolation, and file link without parsing stdout", async () => {
        const h = await harness(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-13T12:34:56.789Z"));
        await h.run();
        expect(h.register).toHaveBeenCalledWith("share-local", expect.objectContaining({ handler: expect.any(Function) }));
        const output = path.join(h.agentDir, "sessions", "transcripts", "2026-10-13T12-34-56-789Z-fixture-id.html");
        expect(h.exec).toHaveBeenCalledExactlyOnceWith("pi", [
            "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
            "--export", h.sessionFile, output,
        ], { cwd: h.root });
        expect(h.last().level).toBe("info"); expect(h.last().text).toContain("Local transcript created:");
        expect(h.last().text).toContain(`\u001B]8;;${pathToFileURL(output).href}\u0007${path.basename(output)}\u001B]8;;\u0007`);
        expect(h.last().text).toContain(`\n${pathToFileURL(output).href}`); expect(h.last().text).not.toContain("PRIVATE STDOUT");
        expect(await readFile(h.sessionFile, "utf8")).toBe("SYNTHETIC SESSION");
    });
    it.each(["nested/report", "nested/report.html", "space and café #1.html", "-flag;$(touch marker).html"])("preserves relative requested destinations as literal arguments: %s", async request => {
        const h = await harness(); await h.run(`  ${request}  `);
        const expected = path.join(h.root, request.endsWith(".html") ? request : `${request}.html`);
        expect(h.output()).toBe(expected); expect(h.last().text).toContain(pathToFileURL(expected).href);
        expect(h.exec).toHaveBeenCalledOnce(); expect(await readFile(expected, "utf8")).toContain("Synthetic transcript");
    });
    it("preserves absolute destinations and adds the html suffix", async () => {
        const h = await harness(); const destination = path.join(h.root, "elsewhere", "report"); await h.run(destination);
        expect(h.output()).toBe(`${destination}.html`); expect(h.last().level).toBe("info");
    });
    it("keeps the home-directory fallback when no agent-dir override is set", async () => {
        const h = await harness(); vi.stubEnv("PI_CODING_AGENT_DIR", undefined); vi.stubEnv("HOME", h.root); vi.stubEnv("USERPROFILE", h.root);
        await h.run(); expect(path.dirname(h.output())).toBe(path.join(os.homedir(), ".pi", "agent", "sessions", "transcripts"));
        expect(h.output().startsWith(h.root)).toBe(true);
    });
    it.each([" / ", "unsafe ../../id", "x".repeat(100)])("keeps safe filename parts for session id %j", async id => {
        const h = await harness(); h.getSessionId.mockReturnValue(id); await h.run();
        expect(path.dirname(h.output())).toBe(path.join(h.agentDir, "sessions", "transcripts"));
        const part = id.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "session";
        expect(path.basename(h.output())).toMatch(new RegExp(`-${part.replaceAll(".", "\\.")}\\.html$`));
    });
    it("waits for idle before inspecting the current session and rejects an in-memory session", async () => {
        const h = await harness(); let release!: () => void;
        h.waitForIdle.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
        const pending = h.run(); await Promise.resolve();
        expect(h.getSessionFile).not.toHaveBeenCalled(); expect(h.exec).not.toHaveBeenCalled();
        h.getSessionFile.mockReturnValue(undefined); release(); await pending;
        expect(h.last()).toEqual({ level: "error", text: "Cannot export an in-memory session." });
        expect(h.getSessionId).not.toHaveBeenCalled(); expect(h.exec).not.toHaveBeenCalled();
    });
    it("reports nonzero exits with clean diagnostics, not stdout or a success link", async () => {
        const h = await harness(async () => result(1, "\u001B[31mCannot read the session\u001B[0m")); await h.run();
        expect(h.last().level).toBe("error"); expect(h.last().text).toContain("exited with code 1");
        expect(h.last().text).toContain("Cannot read the session"); expect(h.last().text).not.toContain("\u001B");
        expect(h.last().text).not.toContain("PRIVATE STDOUT"); expect(h.last().text).not.toContain("Local transcript created:");
        expect(h.exec).toHaveBeenCalledOnce();
    });
    it("treats process termination as failure even after a zero exit and leaves output alone", async () => {
        const h = await harness(async output => { await writeFile(output, "Partial output"); return result(0, "", true); }); await h.run();
        expect(h.last().level).toBe("error"); expect(h.last().text).toContain("terminated");
        expect(await readFile(h.output(), "utf8")).toBe("Partial output"); expect(h.exec).toHaveBeenCalledOnce();
    });
    it("reports the silent failure returned by Pi exec for a missing executable", async () => {
        const h = await harness(async () => ({ code: 1, stdout: "", stderr: "", killed: false })); await h.run();
        expect(h.last().level).toBe("error"); expect(h.last().text).toContain("exited with code 1");
        expect(h.last().text).toContain("available on PATH"); expect(h.exec).toHaveBeenCalledOnce();
    });
    it("reports thrown execution errors without falling back to a private exporter", async () => {
        const h = await harness(async () => { throw new Error("Execution transport failed"); }); await h.run();
        expect(h.last().level).toBe("error"); expect(h.last().text).toContain("Execution transport failed"); expect(h.exec).toHaveBeenCalledOnce();
    });
    it.each(["missing", "empty", "directory"])("does not announce success without a non-empty output file: %s", async kind => {
        const h = await harness(async output => {
            if (kind === "empty") await writeFile(output, "");
            if (kind === "directory") await mkdir(output);
            return result();
        }); await h.run();
        expect(h.last().level).toBe("error"); expect(h.last().text).toContain("Failed to create local transcript:");
        expect(h.last().text).not.toContain("Local transcript created:");
    });
    it("reports destination-directory errors without spawning a process or replacing the blocking file", async () => {
        const h = await harness(); const blocked = path.join(h.root, "blocked"); await writeFile(blocked, "Keep me");
        await h.run("blocked/export.html"); expect(h.last().level).toBe("error"); expect(h.exec).not.toHaveBeenCalled();
        expect(await readFile(blocked, "utf8")).toBe("Keep me");
    });
});
