import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import subagent from "../extensions/orchestration/subagent/index.ts";
import type { SubagentToolDetails } from "../extensions/orchestration/subagent/tool-renderer.ts";

vi.mock("node:child_process", async importOriginal => ({
    ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn(),
}));

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
    vi.unstubAllEnvs();
    vi.mocked(spawn).mockReset();
});

const assistant = (stopReason = "stop", content: unknown[] = [{ type: "text", text: "Done." }]) => ({
    role: "assistant", stopReason, content, errorMessage: stopReason === "error" ? "Provider failed" : undefined,
});
const runEvents = (message = assistant(), aborted = false) => [
    { type: "agent_start" }, { type: "message_end", message },
    { type: "agent_end", messages: [message] }, { type: "agent_settled", aborted },
];

async function fixture(plans: Array<{ events: unknown[]; code?: number }>) {
    const root = await mkdtemp(path.join(os.tmpdir(), "subagent-completion-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    vi.stubEnv("PI_CODING_AGENT_DIR", root);
    const appendEntry = vi.fn();
    const kill = vi.fn(() => true);
    let tool!: ToolDefinition;
    subagent({
        events: createEventBus(), on() {}, registerCommand() {},
        registerTool(definition: ToolDefinition) { tool = definition; }, appendEntry,
    } as unknown as ExtensionAPI);
    vi.mocked(spawn).mockImplementation(() => {
        const plan = plans.shift()!;
        const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean };
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.kill = () => { kill(); child.emit("close", null); return true; };
        queueMicrotask(() => {
            const output = plan.events.map(event => JSON.stringify(event)).join("\n");
            // Exercise split JSONL records and an unterminated final record.
            const split = Math.floor(output.length / 2);
            child.stdout.emit("data", Buffer.from(output.slice(0, split)));
            child.stdout.emit("data", Buffer.from(output.slice(split)));
            child.emit("close", plan.code ?? 0);
        });
        return child as unknown as ReturnType<typeof spawn>;
    });
    const context = {
        cwd: root, hasUI: false,
        sessionManager: { getSessionId: () => "parent", getBranch: () => [] },
    } as unknown as ExtensionToolContext;
    const execute = (params: Record<string, unknown>, signal?: AbortSignal) => tool.execute("call", params, signal, undefined, context);
    return { execute, appendEntry, kill };
}

describe("subagent completion integration", () => {
    it.each([
        ["length", "truncated"], ["error", "error"], ["aborted", "aborted"],
        ["toolUse", "incomplete"], ["deferred", "incomplete"],
    ])("does not report a zero-exit %s response as successful", async (reason, outcome) => {
        const h = await fixture([{ events: runEvents(assistant(reason, [])) }]);
        const result = await h.execute({ agent: "scout", task: "Inspect files" });
        expect(result.isError).toBe(true);
        expect((result.details as SubagentToolDetails).results[0]).toMatchObject({ exitCode: 0, stopReason: reason, outcome });
        expect(h.appendEntry.mock.calls[0][1]).toMatchObject({ outcome });
        expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(outcome === "error" ? "failed" : outcome) });
    });

    it("joins all final text blocks and accepts a successful recovered attempt", async () => {
        const final = assistant("stop", [{ type: "text", text: "First." }, { type: "text", text: "Second.\u2028Still second." }]);
        const h = await fixture([{ events: [
            { type: "agent_start" }, { type: "message_end", message: assistant("error", []) },
            ...runEvents(final),
        ] }]);
        const result = await h.execute({ agent: "scout", task: "Inspect files" });
        expect(result.isError).toBe(false);
        expect((result.details as SubagentToolDetails).results[0]).toMatchObject({ outcome: "completed", output: "First.\nSecond.\u2028Still second." });
    });

    it("requires settlement even when final text and process exit look successful", async () => {
        const h = await fixture([{ events: runEvents().slice(0, -1) }]);
        const result = await h.execute({ agent: "scout", task: "Inspect files" });
        expect(result.isError).toBe(true);
        expect((result.details as SubagentToolDetails).results[0]?.outcome).toBe("incomplete");
    });

    it("does not treat an empty zero-exit child as completed", async () => {
        const h = await fixture([{ events: [] }]);
        const result = await h.execute({ agent: "scout", task: "Inspect files" });
        expect(result.isError).toBe(true);
        expect((result.details as SubagentToolDetails).results[0]?.outcome).toBe("incomplete");
    });

    it("honors settlement cancellation even after a normal-looking final response", async () => {
        const h = await fixture([{ events: runEvents(assistant(), true) }]);
        const result = await h.execute({ agent: "scout", task: "Inspect files" });
        expect(result.isError).toBe(true);
        expect((result.details as SubagentToolDetails).results[0]?.outcome).toBe("aborted");
    });

    it("clears earlier output when a continuation has no final assistant response", async () => {
        const h = await fixture([{ events: [
            ...runEvents(assistant("stop", [{ type: "text", text: "Earlier response" }])).slice(0, -1),
            { type: "agent_start" }, { type: "agent_end", messages: [] }, { type: "agent_settled", aborted: false },
        ] }]);
        const result = await h.execute({ agent: "scout", task: "Inspect" });
        expect((result.details as SubagentToolDetails).results[0]).toMatchObject({ outcome: "incomplete", output: "" });
        expect(result.content[0]).toMatchObject({ text: expect.not.stringContaining("Earlier response") });
    });

    it("returns partial text and the failure diagnostic together", async () => {
        const h = await fixture([{ events: runEvents(assistant("length", [{ type: "text", text: "Partial evidence" }])) }]);
        const result = await h.execute({ agent: "scout", task: "Inspect" });
        expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Partial evidence") });
        expect(result.content[0]).toMatchObject({ text: expect.stringContaining("output-token limit") });
    });

    it("treats a nonzero exit as failure even with successful response evidence", async () => {
        const h = await fixture([{ events: runEvents(), code: 1 }]);
        const result = await h.execute({ agent: "scout", task: "Inspect" });
        expect(result.isError).toBe(true);
        expect((result.details as SubagentToolDetails).results[0]?.outcome).toBe("error");
    });

    it("removes the parent abort listener after the child completes", async () => {
        const h = await fixture([{ events: runEvents() }]);
        const controller = new AbortController();
        await h.execute({ agent: "scout", task: "Inspect" }, controller.signal);
        controller.abort();
        expect(h.kill).not.toHaveBeenCalled();
    });

    it("keeps mixed parallel results but marks the tool result unsuccessful", async () => {
        const h = await fixture([{ events: runEvents() }, { events: runEvents(assistant("length")) }]);
        const result = await h.execute({ tasks: [{ agent: "scout", task: "Inspect" }, { agent: "reviewer", task: "Review" }] });
        expect(result.isError).toBe(true);
        const results = (result.details as SubagentToolDetails).results;
        expect(results.map(item => item.agent)).toEqual(["scout", "reviewer"]);
        expect(results.map(item => item.outcome).sort()).toEqual(["completed", "truncated"]);
        expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Parallel: 1/2 completed") });
    });
});
