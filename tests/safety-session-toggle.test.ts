import { describe, expect, it, vi } from "vitest";
import safetyExtension from "../extensions/safety/index.ts";

type Entry = { type: "custom"; customType: string; data: unknown };

function harness(initialBranch: Entry[] = []) {
    const handlers: Record<string, (event: any, ctx: any) => Promise<any>> = {};
    const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
    const branch = [...initialBranch];
    const notify = vi.fn();
    const select = vi.fn(async () => "Block");
    const confirm = vi.fn(async () => false);
    const ctx = { hasUI: true, ui: { notify, select, confirm }, sessionManager: { getBranch: () => branch } };
    safetyExtension({
        on: (name: string, handler: any) => { handlers[name] = handler; },
        registerCommand: (name: string, command: any) => { commands[name] = command; },
        appendEntry: (customType: string, data: unknown) => { branch.push({ type: "custom", customType, data }); },
    } as any);
    return { handlers, commands, branch, ctx, notify, select, confirm };
}

const bash = { toolName: "bash", input: { command: "rm generated/output" } };
const write = { toolName: "write", input: { path: "/etc/example.conf" } };

describe("session safety toggle", () => {
    it("defaults to on, bypasses safety checks when off, and restores checks when toggled back on", async () => {
        const h = harness();
        await h.handlers.session_start({}, h.ctx);
        await h.commands.safety.handler("", h.ctx);
        expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("ON"), "info");
        expect(await h.handlers.tool_call(bash, h.ctx)).toMatchObject({ block: true });
        expect(h.select).toHaveBeenCalledTimes(1);

        await h.commands.safety.handler("toggle", h.ctx);
        expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("OFF"), "warning");
        expect(await h.handlers.tool_call(bash, h.ctx)).toBeUndefined();
        expect(await h.handlers.tool_call(write, h.ctx)).toBeUndefined();
        expect(await h.handlers.user_bash({ command: "rm generated/output" }, h.ctx)).toBeUndefined();
        expect(h.select).toHaveBeenCalledTimes(1);
        expect(h.confirm).not.toHaveBeenCalled();

        await h.commands.safety.handler("toggle", h.ctx);
        expect(await h.handlers.tool_call(write, h.ctx)).toMatchObject({ block: true });
        expect(h.confirm).toHaveBeenCalledTimes(1);
        expect(h.branch.filter((entry) => entry.customType === "pise-en-place:safety-mode").map((entry) => entry.data)).toEqual([
            { version: 1, promptsEnabled: false },
            { version: 1, promptsEnabled: true },
        ]);
    });

    it("restores the active branch on reload and resets on new sessions or branches", async () => {
        const previous = harness();
        await previous.handlers.session_start({}, previous.ctx);
        await previous.commands.safety.handler("toggle", previous.ctx);

        const reloaded = harness(previous.branch);
        await reloaded.handlers.session_start({}, reloaded.ctx);
        expect(await reloaded.handlers.tool_call(bash, reloaded.ctx)).toBeUndefined();

        reloaded.branch.length = 0;
        await reloaded.handlers.session_tree({}, reloaded.ctx);
        expect(await reloaded.handlers.tool_call(bash, reloaded.ctx)).toMatchObject({ block: true });
        await reloaded.handlers.session_start({}, reloaded.ctx);
        expect(await reloaded.handlers.tool_call(bash, reloaded.ctx)).toMatchObject({ block: true });
    });

    it("rejects unknown arguments without changing safety state", async () => {
        const h = harness();
        await h.handlers.session_start({}, h.ctx);
        await h.commands.safety.handler("off", h.ctx);
        expect(h.notify).toHaveBeenLastCalledWith("Usage: /safety [toggle]", "warning");
        expect(await h.handlers.tool_call(bash, h.ctx)).toMatchObject({ block: true });
    });
});
