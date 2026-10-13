import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecResult, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import roadmap from "../extensions/productivity/roadmap-writer.ts";

const cleanup: string[] = [];
afterEach(async () => { for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true }); });
function stdout(reason = "stop", text = "Updated the idea.", settled = true, errorMessage?: string) {
    const message = { role: "assistant", stopReason: reason, errorMessage, content: [{ type: "text", text }] };
    const events: unknown[] = [
        { type: "session", id: "child" }, { type: "agent_start" },
        { type: "message_end", message: { role: "user", content: "PRIVATE REQUEST" } },
        { type: "tool_execution_end", result: { content: [{ type: "text", text: "PRIVATE TOOL OUTPUT" }] } },
        { type: "message_end", message }, { type: "agent_end", messages: [message] },
    ];
    if (settled) events.push({ type: "agent_settled", aborted: false });
    return events.map(event => JSON.stringify(event)).join("\n");
}
const result = (output = stdout(), code = 0, stderr = "", killed = false): ExecResult => ({ stdout: output, code, stderr, killed });
async function harness(run?: (file: string) => Promise<ExecResult>) {
    const root = await mkdtemp(path.join(os.tmpdir(), "roadmap-writer-")); cleanup.push(root);
    const file = path.join(root, "ROADMAP.md");
    await writeFile(file, "# Roadmap\n\n- Existing local edits\n");
    const notices: { text: string; level: string }[] = [];
    let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    const exec = vi.fn<ExtensionAPI["exec"]>(async () => run ? run(file) : result());
    roadmap({ exec, registerCommand: (_name: string, definition: any) => { handler = definition.handler; } } as unknown as ExtensionAPI);
    const ctx = { cwd: root, ui: { notify: (text: string, level: string) => notices.push({ text, level }) } } as unknown as ExtensionCommandContext;
    return { root, file, exec, notices, run: async (request = "Add an idea") => { await handler!(request, ctx); },
        last: () => notices.at(-1)! };
}

describe("roadmap result handling", () => {
    it("confirms updates from normal settlement plus actual file changes, preserving isolation/usage flags", async () => {
        const h = await harness(async file => { await writeFile(file, "# Updated roadmap\n"); return result(); });
        await h.run();
        expect(h.last()).toMatchObject({ level: "info", text: expect.stringContaining("ROADMAP.md updated") });
        expect(h.last().text).toContain("Updated the idea.");
        expect(h.last().text).not.toContain("PRIVATE");
        const [command, args, options] = h.exec.mock.calls[0];
        expect(command).toBe("pi");
        expect(args).toEqual(expect.arrayContaining(["--print", "--mode", "json", "--no-session", "--no-extensions", "--extension",
            "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--tools", "read,edit,write"]));
        expect(args[args.indexOf("--extension") + 1]).toMatch(/extensions\/usage\/index\.ts$/);
        expect(args.at(-1)).toContain("Add an idea");
        expect(options).toEqual({ cwd: h.root, timeout: 600_000 });
        expect(h.exec).toHaveBeenCalledOnce();
    });
    it.each([0, 1])("warns about preserved changes after a truncated response (exit %s), without retries", async code => {
        const h = await harness(async file => {
            await writeFile(file, "# Roadmap\n\n- New idea\n");
            return result(stdout("length", "Partial summary"), code, "Output token limit reached");
        });
        await h.run();
        expect(h.last()).toMatchObject({ level: "warning", text: expect.stringContaining("changed during the run") });
        expect(h.last().text).toContain("truncated"); expect(h.last().text).toContain("Partial summary");
        expect(h.last().text).toContain("Output token limit reached");
        expect(h.last().text).toContain("Review it before rerunning");
        expect(h.last().text).not.toContain("ROADMAP.md updated");
        expect(await readFile(h.file, "utf8")).toContain("New idea");
        expect(h.exec).toHaveBeenCalledOnce();
    });
    it.each(["error", "aborted", "toolUse", "deferred"])("warns on observed changes after %s, rather than claiming transactional failure", async reason => {
        const h = await harness(async file => { await writeFile(file, "Partial edit"); return result(stdout(reason), 0, "Diagnostic"); });
        await h.run();
        expect(h.last().level).toBe("warning");
        expect(h.last().text).toContain("completion could not be confirmed");
        expect(h.last().text).toContain("Diagnostic");
        expect(await readFile(h.file, "utf8")).toBe("Partial edit");
        expect(h.exec).toHaveBeenCalledOnce();
    });
    it("does not treat JSON-mode zero exit or an already-dirty file as proof of successful edits", async () => {
        const h = await harness(async () => result(stdout("error", "")));
        await h.run();
        expect(h.last()).toMatchObject({ level: "error", text: expect.stringContaining("No content change was detected") });
        expect(h.last().text).not.toContain("ROADMAP.md updated");
        expect(await readFile(h.file, "utf8")).toContain("Existing local edits");
    });
    it("reports a normally completed no-op without claiming an update", async () => {
        const h = await harness(); await h.run();
        expect(h.last()).toMatchObject({ level: "info", text: expect.stringContaining("No content change detected") });
    });
    it("treats process failure as unsuccessful even after a normal response", async () => {
        const h = await harness(async file => { await writeFile(file, "Partial edit"); return result(stdout(), 1, "Process error"); });
        await h.run();
        expect(h.last().level).toBe("warning"); expect(h.last().text).toContain("exit code: 1");
        expect(h.last().text).toContain("Process error"); expect(h.last().text).not.toContain("completed normally");
    });
    it("honors process termination over successful-looking response evidence", async () => {
        const h = await harness(async file => { await writeFile(file, "Partial edit"); return result(stdout(), 0, "", true); });
        await h.run();
        expect(h.last().level).toBe("warning"); expect(h.last().text).toContain("timeout or abort");
        expect(h.last().text).not.toContain("ROADMAP.md updated");
    });
    it("checks for partial changes even when execution throws", async () => {
        const h = await harness(async file => { await writeFile(file, "Partial edit"); throw new Error("Transport failed"); });
        await h.run();
        expect(h.last().level).toBe("warning"); expect(h.last().text).toContain("Transport failed");
        expect(await readFile(h.file, "utf8")).toBe("Partial edit");
        expect(h.exec).toHaveBeenCalledOnce();
    });
    it.each(["missing", "malformed", "empty"])("requires reliable completion evidence: %s", async mode => {
        const h = await harness(async file => {
            await writeFile(file, "Partial edit");
            return result(mode === "empty" ? "" : mode === "missing" ? stdout("stop", "Summary", false) : `${stdout()}\nPRIVATE INVALID OUTPUT`);
        });
        await h.run();
        expect(h.last().level).toBe("warning"); expect(h.last().text).not.toContain("ROADMAP.md updated");
        expect(h.last().text).not.toContain("PRIVATE INVALID OUTPUT");
    });
    it.each(["length", "error"])("keeps safe %s diagnostics visible alongside a malformed-output warning", async reason => {
        const h = await harness(async file => {
            await writeFile(file, "Partial edit");
            return result(`${stdout(reason, "Partial summary", true, "Provider rejected the request")}\nPRIVATE MALFORMED RECORD`);
        });
        await h.run();
        expect(h.last().level).toBe("warning"); expect(h.last().text).toContain("malformed or incomplete");
        expect(h.last().text).toContain(reason === "length" ? "truncated" : "Provider rejected the request");
        expect(h.last().text).toContain("Partial summary"); expect(h.last().text).not.toContain("PRIVATE MALFORMED RECORD");
        expect(h.last().text).not.toContain("ROADMAP.md updated");
    });

    it("does not substitute earlier answers after a textless aborted continuation", async () => {
        const h = await harness(async file => {
            await writeFile(file, "Partial edit");
            const empty = { role: "assistant", stopReason: "aborted", content: [] };
            return result(`${stdout("stop", "Earlier answer")}\n${[
                { type: "agent_start" }, { type: "message_end", message: empty }, { type: "agent_end", messages: [empty] },
                { type: "agent_settled", aborted: true },
            ].map(event => JSON.stringify(event)).join("\n")}`);
        });
        await h.run();
        expect(h.last().level).toBe("warning"); expect(h.last().text).not.toContain("Earlier answer");
    });
    it("reports verification uncertainty if the target disappears after a normal child run", async () => {
        const h = await harness(async file => { await rm(file); return result(); }); await h.run();
        expect(h.last().level).toBe("warning"); expect(h.last().text).toContain("Do not assume no changes");
        expect(h.last().text).toContain("Could not inspect ROADMAP.md"); expect(h.last().text).not.toContain("ROADMAP.md updated");
    });
    it("reports child execution errors without claiming other requested files were untouched", async () => {
        const h = await harness(async () => { throw new Error("Could not launch pi"); }); await h.run("Update roadmap and another file");
        expect(h.last().level).toBe("error"); expect(h.last().text).toContain("Could not launch pi");
        expect(h.last().text).toContain("other requested files");
    });
    it.each(["", "-h", "--help"])("keeps help/no-argument behavior non-mutating: %j", async request => {
        const h = await harness(); await h.run(request);
        expect(h.last().level).toBe("info"); expect(h.last().text).toContain("Usage: /roadmap"); expect(h.exec).not.toHaveBeenCalled();
    });
    it("does not start a child for a missing or unreadable target", async () => {
        const h = await harness(); await rm(h.file); await h.run();
        expect(h.last().text).toContain("Cannot find ROADMAP.md"); expect(h.exec).not.toHaveBeenCalled();
        await mkdir(h.file); await h.run();
        expect(h.last().text).toContain("Cannot read ROADMAP.md"); expect(h.exec).not.toHaveBeenCalled();
    });
});
