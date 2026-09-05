import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getUsageSessionState, inheritedUsageTagsEnvironmentVariable } from "../../../src/shared/usage-session.ts";
import { Type } from "typebox";
import { getSubagentDefinitions, type SubagentDefinition } from "./agents.ts";
import { loadSubagentConfig, type ResolvedSubagentConfig } from "./config.ts";
import { createSubagentWidget } from "./widget.ts";
import { formatSubagentSessionRuns, getSubagentSessionRuns, subagentSessionEntryType, type SubagentSessionRun } from "./sessions.ts";
import { renderSubagentCall, renderSubagentResult, type SubagentToolDetails, type SubagentToolResult } from "./tool-renderer.ts";

const maxParallelTasks = 8;
const maxConcurrency = 4;
const outputCap = 50 * 1024;

type Task = { agent: string; task: string };
type Result = SubagentToolResult & {
    config?: ResolvedSubagentConfig;
    output: string;
    stderr: string;
    childSessionId?: string;
    childSessionDir?: string;
    startedAt?: string;
};

type Details = SubagentToolDetails;

const taskSchema = Type.Object({
    agent: Type.String({ description: "Package-owned subagent name: scout, researcher, or reviewer." }),
    task: Type.String({ description: "Focused task for the subagent." }),
});

const parameters = Type.Object({
    agent: Type.Optional(Type.String({ description: "Subagent name for a single task." })),
    task: Type.Optional(Type.String({ description: "Task for a single subagent." })),
    tasks: Type.Optional(Type.Array(taskSchema, { description: "Independent subagent tasks to execute in parallel." })),
});

function invocation(args: string[]): { command: string; args: string[] } {
    const script = process.argv[1];
    if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) return { command: process.execPath, args: [script, ...args] };
    return { command: "pi", args };
}

function finalOutput(messages: Message[]): { output: string; stopReason?: string } {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role !== "assistant") continue;
        const text = message.content.find((part) => part.type === "text");
        if (text?.type === "text") return { output: text.text, stopReason: message.stopReason };
    }
    return { output: "" };
}

function formatResult(result: Result): string {
    const status = result.exitCode === 0 && result.stopReason !== "error" ? "completed" : "failed";
    const output = result.output || result.stderr || "(no output)";
    return `### [${result.agent}] ${status}\n\n${output}`;
}

function truncate(value: string): string {
    if (Buffer.byteLength(value, "utf8") <= outputCap) return value;
    return `${value.slice(0, outputCap)}\n\n[Output truncated; full result is retained in tool details.]`;
}

async function runSubagent(
    definition: SubagentDefinition,
    task: string,
    cwd: string,
    config: ResolvedSubagentConfig,
    sessionDir: string,
    inheritedTags: string[],
    signal: AbortSignal | undefined,
    update: (result: Result) => void,
): Promise<Result> {
    const promptDir = await mkdtemp(path.join(os.tmpdir(), "pise-subagent-"));
    const childSessionId = randomUUID();
    await mkdir(sessionDir, { recursive: true });
    const promptPath = path.join(promptDir, `${definition.name}.md`);
    await writeFile(promptPath, definition.systemPrompt, { mode: 0o600 });
    const result: Result = {
        agent: definition.name,
        task,
        config,
        output: "",
        stderr: "",
        exitCode: -1,
        childSessionId,
        childSessionDir: sessionDir,
        startedAt: new Date().toISOString(),
    };

    try {
        const args = [
            "--mode", "json", "--print", "--session-dir", sessionDir, "--session-id", childSessionId, "--name", `subagent: ${definition.name}`,
            "--no-extensions", "--extension", path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../usage/index.ts"),
            "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
            "--model", config.model, "--thinking", config.thinking, "--tools", definition.tools.join(","),
            "--append-system-prompt", promptPath, `Task: ${task}`,
        ];
        const child = invocation(args);
        await new Promise<void>((resolve) => {
            const childProcess = spawn(child.command, child.args, {
                cwd,
                shell: false,
                stdio: ["ignore", "pipe", "pipe"],
                env: { ...process.env, [inheritedUsageTagsEnvironmentVariable]: JSON.stringify([...inheritedTags, "subagent", `subagent-${definition.name}`]) },
            });
            let stdout = "";
            let aborted = false;
            const consumeLine = (line: string) => {
                try {
                    const event = JSON.parse(line) as { type?: string; message?: Message; toolName?: string };
                    if (event.type === "tool_execution_start" && event.toolName) {
                        result.activity = event.toolName;
                        update(result);
                        return;
                    }
                    if (event.type !== "message_end" || !event.message || event.message.role !== "assistant") return;
                    const next = finalOutput([event.message]);
                    result.output = next.output;
                    result.stopReason = next.stopReason;
                    result.activity = "finalizing response";
                    update(result);
                } catch {
                    // JSON mode may emit diagnostics; stderr retains process diagnostics.
                }
            };
            childProcess.stdout.on("data", (chunk) => {
                stdout += chunk.toString();
                const lines = stdout.split("\n");
                stdout = lines.pop() ?? "";
                lines.forEach(consumeLine);
            });
            childProcess.stderr.on("data", (chunk) => { result.stderr += chunk.toString(); });
            childProcess.on("error", (error) => { result.stderr += error.message; });
            childProcess.on("close", (code) => {
                if (stdout.trim()) consumeLine(stdout);
                result.exitCode = aborted ? 1 : (code ?? 1);
                if (aborted) result.stderr ||= "Subagent aborted.";
                result.activity = result.exitCode === 0 && result.stopReason !== "error" ? "complete" : "failed";
                resolve();
            });
            const abort = () => { aborted = true; childProcess.kill("SIGTERM"); };
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
        });
        return result;
    } finally {
        await rm(promptDir, { recursive: true, force: true });
    }
}

async function mapConcurrent<T>(items: T[], fn: (item: T, index: number) => Promise<void>): Promise<void> {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(maxConcurrency, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            await fn(items[index], index);
        }
    }));
}

export default function (pi: ExtensionAPI) {
    const widgetRuns = new Map<string, Result[]>();

    const renderWidget = (ctx: any) => {
        if (!ctx.hasUI) return;
        const items = [...widgetRuns.values()].flat();
        ctx.ui.setWidget("pise-subagents", items.length ? createSubagentWidget(items) : undefined);
    };

    // Keep completed work visible while the main agent consumes its results; remove it once the parent turn settles.
    pi.on("agent_settled", (_event, ctx) => {
        widgetRuns.clear();
        renderWidget(ctx);
    });

    pi.registerCommand("subagents", {
        description: "List retained subagent sessions for this parent session",
        handler: async (_args, ctx) => {
            const runs = getSubagentSessionRuns(ctx.sessionManager.getEntries());
            ctx.ui.notify(formatSubagentSessionRuns(runs), "info");
        },
    });

    pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description: "Delegate focused, isolated read-only work to package-owned scout, researcher, or reviewer subagents. Use agent + task for one task or tasks for independent parallel work.",
        parameters,
        renderCall: renderSubagentCall,
        renderResult: renderSubagentResult,
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const single = params.agent && params.task ? [{ agent: params.agent, task: params.task }] : undefined;
            const tasks = params.tasks?.length ? params.tasks : single;
            if (!tasks || (params.tasks?.length && single)) {
                return { content: [{ type: "text", text: "Provide exactly one mode: agent + task, or tasks." }], details: { mode: "single", results: [] } satisfies Details, isError: true };
            }
            if (tasks.length > maxParallelTasks) {
                return { content: [{ type: "text", text: `Too many parallel tasks (${tasks.length}); maximum is ${maxParallelTasks}.` }], details: { mode: "parallel", results: [] } satisfies Details, isError: true };
            }
            const definitions = new Map(getSubagentDefinitions().map((definition) => [definition.name, definition]));
            const unknown = tasks.map(({ agent }) => agent).filter((agent) => !definitions.has(agent));
            if (unknown.length) {
                return { content: [{ type: "text", text: `Unknown subagent(s): ${unknown.join(", ")}. Available: ${[...definitions.keys()].join(", ")}.` }], details: { mode: tasks.length > 1 ? "parallel" : "single", results: [] } satisfies Details, isError: true };
            }

            const parentSessionId = ctx.sessionManager.getSessionId();
            const childSessionDir = path.join(getAgentDir(), "subagent-sessions", parentSessionId);
            const inheritedTags = getUsageSessionState(ctx.sessionManager.getBranch())?.tags ?? [];
            const results: Result[] = tasks.map(({ agent, task }) => ({ agent, task, output: "", stderr: "", exitCode: -1, activity: "starting" }));
            widgetRuns.set(toolCallId, results);
            renderWidget(ctx);
            const mode = tasks.length > 1 ? "parallel" as const : "single" as const;
            const reportProgress = () => {
                renderWidget(ctx);
                onUpdate?.({
                    content: [{ type: "text", text: mode === "parallel" ? `Subagents: ${results.filter((result) => result.exitCode !== -1).length}/${results.length} complete` : results[0].output || "(running...)" }],
                    details: { mode, results: [...results] } satisfies Details,
                });
            };

            await mapConcurrent(tasks, async (task, index) => {
                const definition = definitions.get(task.agent)!;
                const config = loadSubagentConfig(ctx.cwd, definition.name, definition.defaults);
                results[index] = await runSubagent(definition, task.task, ctx.cwd, config, childSessionDir, inheritedTags, signal, (partial) => { results[index] = { ...partial }; reportProgress(); });
                const result = results[index];
                if (result.childSessionId && result.childSessionDir && result.startedAt) {
                    const run: SubagentSessionRun = {
                        version: 1,
                        parentSessionId,
                        toolCallId,
                        agent: result.agent,
                        task: result.task,
                        childSessionId: result.childSessionId,
                        sessionDir: result.childSessionDir,
                        startedAt: result.startedAt,
                        completedAt: new Date().toISOString(),
                        exitCode: result.exitCode,
                        ...(result.stopReason ? { stopReason: result.stopReason } : {}),
                    };
                    pi.appendEntry(subagentSessionEntryType, run);
                }
                reportProgress();
            });

            const failures = results.filter((result) => result.exitCode !== 0 || result.stopReason === "error");
            const content = mode === "single"
                ? formatResult(results[0])
                : `Parallel: ${results.length - failures.length}/${results.length} completed\n\n${results.map((result) => formatResult({ ...result, output: truncate(result.output) })).join("\n\n---\n\n")}`;
            return { content: [{ type: "text", text: content }], details: { mode, results } satisfies Details, isError: mode === "single" && failures.length > 0 };
        },
    });
}
