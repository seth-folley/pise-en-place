import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getSubagentDefinitions, type SubagentDefinition } from "./agents.ts";
import { loadSubagentConfig, type ResolvedSubagentConfig } from "./config.ts";

const maxParallelTasks = 8;
const maxConcurrency = 4;
const outputCap = 50 * 1024;

type Task = { agent: string; task: string };
type Result = {
    agent: string;
    task: string;
    config?: ResolvedSubagentConfig;
    output: string;
    stderr: string;
    exitCode: number;
    stopReason?: string;
};

type Details = { mode: "single" | "parallel"; results: Result[] };

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
    signal: AbortSignal | undefined,
    update: (result: Result) => void,
): Promise<Result> {
    const promptDir = await mkdtemp(path.join(os.tmpdir(), "pise-subagent-"));
    const promptPath = path.join(promptDir, `${definition.name}.md`);
    await writeFile(promptPath, definition.systemPrompt, { mode: 0o600 });
    const result: Result = { agent: definition.name, task, config, output: "", stderr: "", exitCode: -1 };

    try {
        const args = [
            "--mode", "json", "--print", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
            "--model", config.model, "--thinking", config.thinking, "--tools", definition.tools.join(","),
            "--append-system-prompt", promptPath, `Task: ${task}`,
        ];
        const child = invocation(args);
        await new Promise<void>((resolve) => {
            const process = spawn(child.command, child.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
            let stdout = "";
            let aborted = false;
            const consumeLine = (line: string) => {
                try {
                    const event = JSON.parse(line) as { type?: string; message?: Message };
                    if (event.type !== "message_end" || !event.message || event.message.role !== "assistant") return;
                    const next = finalOutput([event.message]);
                    result.output = next.output;
                    result.stopReason = next.stopReason;
                    update(result);
                } catch {
                    // JSON mode may emit diagnostics; stderr retains process diagnostics.
                }
            };
            process.stdout.on("data", (chunk) => {
                stdout += chunk.toString();
                const lines = stdout.split("\n");
                stdout = lines.pop() ?? "";
                lines.forEach(consumeLine);
            });
            process.stderr.on("data", (chunk) => { result.stderr += chunk.toString(); });
            process.on("error", (error) => { result.stderr += error.message; });
            process.on("close", (code) => {
                if (stdout.trim()) consumeLine(stdout);
                result.exitCode = aborted ? 1 : (code ?? 1);
                if (aborted) result.stderr ||= "Subagent aborted.";
                resolve();
            });
            const abort = () => { aborted = true; process.kill("SIGTERM"); };
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
    pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description: "Delegate focused, isolated read-only work to package-owned scout, researcher, or reviewer subagents. Use agent + task for one task or tasks for independent parallel work.",
        parameters,
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
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

            const results: Result[] = tasks.map(({ agent, task }) => ({ agent, task, output: "", stderr: "", exitCode: -1 }));
            const mode = tasks.length > 1 ? "parallel" as const : "single" as const;
            const reportProgress = () => onUpdate?.({
                content: [{ type: "text", text: mode === "parallel" ? `Subagents: ${results.filter((result) => result.exitCode !== -1).length}/${results.length} complete` : results[0].output || "(running...)" }],
                details: { mode, results: [...results] } satisfies Details,
            });

            await mapConcurrent(tasks, async (task, index) => {
                const definition = definitions.get(task.agent)!;
                const config = loadSubagentConfig(ctx.cwd, definition.name, definition.defaults);
                results[index] = await runSubagent(definition, task.task, ctx.cwd, config, signal, (partial) => { results[index] = { ...partial }; reportProgress(); });
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
