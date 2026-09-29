import { describe, expect, it, vi } from "vitest";
import safetyExtension from "../extensions/safety/index.ts";

vi.mock("../src/shared/supacode-notifications.ts", () => ({ notifySupacodeAttention: vi.fn() }));

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function harness() {
    const handlers: Record<string, (event: any, ctx: any) => Promise<any>> = {};
    const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
    const entries: Array<{ customType: string; data: any }> = [];
    const select = vi.fn(async (..._args: any[]): Promise<string | undefined> => "Block");
    const confirm = vi.fn(async (..._args: any[]): Promise<boolean> => false);
    const ctx = {
        hasUI: true,
        signal: new AbortController().signal,
        ui: { select, confirm, notify: vi.fn() },
        sessionManager: { getBranch: () => [] },
    };
    safetyExtension({
        on: (name: string, handler: any) => { handlers[name] = handler; },
        registerCommand: (name: string, command: any) => { commands[name] = command; },
        appendEntry: (customType: string, data: any) => { entries.push({ customType, data }); },
    } as any);
    return { handlers, commands, ctx, select, confirm, entries };
}

// Pi dispatches each ctx.executeTool/codemode call with its actual tool name and
// input, plus parentToolCallId. These are handler-level contract tests, not a JS parser.
const nested = (toolName: string, input: Record<string, unknown>, index = 1) => ({
    type: "tool_call", toolName, input, toolCallId: `codemode-parent/${index}`, parentToolCallId: "codemode-parent",
});
const riskyBash = nested("bash", { command: "rm generated/output" });
const protectedFile = (name = "write") => nested(name, { path: "/etc/example.conf" }, 2);

describe("safety for nested tool calls", () => {
    it("does not prompt for the outer script or safe nested calls", async () => {
        const h = harness();
        expect(await h.handlers.tool_call({ type: "tool_call", toolName: "codemode", input: { code: "await tools.bash(args)" } }, h.ctx)).toBeUndefined();
        expect(await h.handlers.tool_call(nested("bash", { command: "git status --short" }), h.ctx)).toBeUndefined();
        expect(await h.handlers.tool_call(nested("read", { path: "/etc/example.conf" }), h.ctx)).toBeUndefined();
        expect(await h.handlers.tool_call(nested("write", { path: "src/example.ts" }), h.ctx)).toBeUndefined();
        expect(h.select).not.toHaveBeenCalled();
        expect(h.confirm).not.toHaveBeenCalled();
        expect(h.entries).toEqual([]);
    });

    it("requires a separate approval on every risky nested bash call", async () => {
        const h = harness();
        h.select.mockResolvedValueOnce("Allow once").mockResolvedValueOnce("Block");
        expect(await h.handlers.tool_call(riskyBash, h.ctx)).toBeUndefined();
        expect(await h.handlers.tool_call(riskyBash, h.ctx)).toMatchObject({ block: true, reason: expect.stringContaining("file deletion") });
        expect(h.select).toHaveBeenCalledTimes(2);
        expect(h.entries.map((entry) => entry.data.decision)).toEqual(["allow", "block"]);
    });

    it.each(["write", "edit"])("gates protected nested %s calls", async (name) => {
        const h = harness();
        expect(await h.handlers.tool_call(protectedFile(name), h.ctx)).toMatchObject({ block: true });
        h.confirm.mockResolvedValueOnce(true);
        expect(await h.handlers.tool_call(protectedFile(name), h.ctx)).toBeUndefined();
        expect(h.confirm).toHaveBeenCalledTimes(2);
        expect(h.entries.map((entry) => entry.data.decision)).toEqual(["block", "allow"]);
    });

    it("keeps Explain and subsequent explanation capture working for nested bash", async () => {
        const h = harness();
        h.select.mockResolvedValueOnce("Explain");
        expect(await h.handlers.tool_call(riskyBash, h.ctx)).toMatchObject({ block: true, reason: expect.stringContaining("pending explanation") });
        await h.handlers.message_end({ message: { role: "assistant", content: [{ type: "text", text:
            "```dangerous-command-explanation\ntools: rm\ndescription: Deletes generated output.\nreason: Clean build artifacts.\nrisk: medium\n```",
        }] } }, h.ctx);
        await h.handlers.tool_call(riskyBash, h.ctx);
        expect(h.select.mock.calls[1][0]).toContain("Previous explanation:");
        expect(h.select.mock.calls[1][0]).toContain("Deletes generated output.");
        expect(h.entries.map((entry) => entry.data.decision)).toEqual(["explain", "block"]);
    });

    it("honors /safety toggle for nested calls", async () => {
        const h = harness();
        await h.commands.safety.handler("toggle", h.ctx);
        expect(await h.handlers.tool_call(riskyBash, h.ctx)).toBeUndefined();
        expect(await h.handlers.tool_call(protectedFile(), h.ctx)).toBeUndefined();
        expect(h.select).not.toHaveBeenCalled();
        expect(h.confirm).not.toHaveBeenCalled();
        await h.commands.safety.handler("toggle", h.ctx);
        expect(await h.handlers.tool_call(riskyBash, h.ctx)).toMatchObject({ block: true });
        expect(await h.handlers.tool_call(protectedFile(), h.ctx)).toMatchObject({ block: true });
    });

    it("blocks hazardous nested calls without UI and does not log unseen dialogs", async () => {
        const h = harness();
        h.ctx.hasUI = false;
        expect(await h.handlers.tool_call(riskyBash, h.ctx)).toMatchObject({ block: true });
        expect(await h.handlers.tool_call(protectedFile(), h.ctx)).toMatchObject({ block: true });
        expect(h.select).not.toHaveBeenCalled();
        expect(h.confirm).not.toHaveBeenCalled();
        expect(h.entries).toEqual([]);
    });
});

describe("concurrent safety decisions", () => {
    it("serializes bash, protected-file and user-bash prompts without holding up safe calls", async () => {
        const h = harness();
        const bashDecision = deferred<string>();
        const fileDecision = deferred<boolean>();
        h.select.mockImplementationOnce(() => bashDecision.promise).mockResolvedValueOnce("Block");
        h.confirm.mockImplementationOnce(() => fileDecision.promise);
        const bash = h.handlers.tool_call(riskyBash, h.ctx);
        const file = h.handlers.tool_call(protectedFile(), h.ctx);
        const user = h.handlers.user_bash({ command: "git reset --hard" }, h.ctx);
        await expect.poll(() => h.select.mock.calls.length).toBe(1);
        expect(h.confirm).not.toHaveBeenCalled();
        expect(await h.handlers.tool_call(nested("bash", { command: "git status --short" }), h.ctx)).toBeUndefined();
        bashDecision.resolve("Allow once");
        expect(await bash).toBeUndefined();
        await expect.poll(() => h.confirm.mock.calls.length).toBe(1);
        expect(h.select).toHaveBeenCalledTimes(1);
        fileDecision.resolve(false);
        expect(await file).toMatchObject({ block: true });
        expect(await user).toMatchObject({ result: { exitCode: 126 } });
        expect(h.entries.map((entry) => [entry.data.kind, entry.data.decision])).toEqual([
            ["bash", "allow"], ["file", "block"], ["bash", "block"],
        ]);
        expect(h.select.mock.calls[0][0]).toContain("rm generated/output");
        expect(h.confirm.mock.calls[0][1]).toContain("/etc/example.conf");
        expect(h.select.mock.calls[1][0]).toContain("git reset --hard");
    });

    it("keeps simultaneous bash approvals independent", async () => {
        const h = harness();
        const first = deferred<string>();
        h.select.mockImplementationOnce(() => first.promise).mockResolvedValueOnce("Block");
        const a = h.handlers.tool_call(riskyBash, h.ctx);
        const b = h.handlers.tool_call(nested("bash", { command: "git reset --hard" }, 2), h.ctx);
        await expect.poll(() => h.select.mock.calls.length).toBe(1);
        first.resolve("Allow once");
        expect(await a).toBeUndefined();
        expect(await b).toMatchObject({ block: true, reason: expect.stringContaining("git destructive operation") });
        expect(h.entries.map((entry) => entry.data.decision)).toEqual(["allow", "block"]);
    });

    it("releases the queue after a dialog error without approving that operation", async () => {
        const h = harness();
        const first = deferred<string>();
        h.select.mockImplementationOnce(() => first.promise);
        const a = h.handlers.tool_call(riskyBash, h.ctx);
        const rejection = expect(a).rejects.toThrow("dialog failed");
        const b = h.handlers.tool_call(protectedFile(), h.ctx);
        await expect.poll(() => h.select.mock.calls.length).toBe(1);
        first.reject(new Error("dialog failed"));
        await rejection;
        expect(await b).toMatchObject({ block: true });
        expect(h.confirm).toHaveBeenCalledTimes(1);
    });

    it("cancels the visible prompt and skips queued prompts from the aborted turn", async () => {
        const h = harness();
        const controller = new AbortController();
        h.ctx.signal = controller.signal;
        h.select.mockImplementationOnce((_title, _choices, options) => new Promise((resolve) => {
            options.signal.addEventListener("abort", () => resolve(undefined), { once: true });
        }));
        const a = h.handlers.tool_call(riskyBash, h.ctx);
        const b = h.handlers.tool_call(protectedFile(), h.ctx);
        await expect.poll(() => h.select.mock.calls.length).toBe(1);
        expect(h.select.mock.calls[0][2].signal).toBe(controller.signal);
        controller.abort();
        // ctx.signal can point at a new turn before queued decisions are processed.
        h.ctx.signal = new AbortController().signal;
        expect(await a).toMatchObject({ block: true });
        expect(await b).toMatchObject({ block: true });
        expect(h.confirm).not.toHaveBeenCalled();
        expect(h.entries.map((entry) => entry.data.decision)).toEqual(["block"]);
        expect(await h.handlers.tool_call(protectedFile(), h.ctx)).toMatchObject({ block: true });
        expect(h.confirm.mock.calls[0][2].signal).toBe(h.ctx.signal);
    });

    it.each(["bash", "write"])("does not accept a late %s approval after cancellation", async (name) => {
        const h = harness();
        const controller = new AbortController();
        h.ctx.signal = controller.signal;
        const decision = deferred<any>();
        if (name === "bash") h.select.mockImplementationOnce(() => decision.promise);
        else h.confirm.mockImplementationOnce(() => decision.promise);
        const result = h.handlers.tool_call(name === "bash" ? riskyBash : protectedFile(), h.ctx);
        await expect.poll(() => h.select.mock.calls.length + h.confirm.mock.calls.length).toBe(1);
        controller.abort();
        decision.resolve(name === "bash" ? "Allow once" : true);
        expect(await result).toMatchObject({ block: true });
        expect(h.entries[0].data.decision).toBe("block");
    });
});
