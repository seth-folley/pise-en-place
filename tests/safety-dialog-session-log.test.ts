import { describe, expect, it } from "vitest";
import safetyExtension from "../extensions/safety/index.ts";

describe("safety dialog session logging", () => {
    it("persists each displayed bash permission decision", async () => {
        const handlers: Record<string, (event: any, ctx: any) => Promise<unknown>> = {};
        const entries: Array<{ type: string; data: unknown }> = [];
        safetyExtension({
            on: (event: string, handler: any) => { handlers[event] = handler; },
            appendEntry: (type: string, data: unknown) => { entries.push({ type, data }); },
        } as any);

        const result = await handlers.tool_call(
            { toolName: "bash", input: { command: "rm generated/output" } },
            { hasUI: true, ui: { select: async () => "Block" } },
        );

        expect(result).toEqual({ block: true, reason: "Blocked potentially dangerous operation: file deletion" });
        expect(entries).toEqual([{
            type: "pise-en-place:safety-dialog",
            data: {
                kind: "bash",
                subject: "rm generated/output",
                reasons: ["file deletion"],
                decision: "block",
            },
        }]);
    });

    it("records protected-file confirmation outcomes but not noninteractive blocks", async () => {
        const handlers: Record<string, (event: any, ctx: any) => Promise<unknown>> = {};
        const entries: Array<{ type: string; data: unknown }> = [];
        safetyExtension({
            on: (event: string, handler: any) => { handlers[event] = handler; },
            appendEntry: (type: string, data: unknown) => { entries.push({ type, data }); },
        } as any);

        await handlers.tool_call(
            { toolName: "write", input: { path: "/etc/example.conf" } },
            { hasUI: true, ui: { confirm: async () => true } },
        );
        await handlers.tool_call(
            { toolName: "bash", input: { command: "rm generated/output" } },
            { hasUI: false, ui: {} },
        );

        expect(entries).toEqual([{
            type: "pise-en-place:safety-dialog",
            data: {
                kind: "file",
                subject: "Tool: write\nPath: /etc/example.conf",
                reasons: ["writing system files outside ~/.pi"],
                decision: "allow",
            },
        }]);
    });
});
