import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedCell, ResolvedScenario, Usage } from "./domain.ts";
import { ARTIFACT_LIMITS } from "./domain.ts";
import { redactText, redactValue } from "./security.ts";

export interface HarnessResult { code: number; durationMs: number; usage: Usage; traceFile: string; toolNames: string[]; stderr: string; error?: string }
export interface HarnessEvent { type: "tool"; toolName: string }
export interface HarnessExecutionOptions { runDir: string; workspace: string; skillDirectory?: string; signal: AbortSignal; onEvent?: (event: HarnessEvent) => Promise<void> | void; onPid?: (pid: number) => void; onOutput?: (stream: "stdout" | "stderr", text: string) => void }
export interface HarnessAdapter { readonly harness: "pi"; execute(cell: ResolvedCell, scenario: ResolvedScenario & { prompt: string }, options: HarnessExecutionOptions): Promise<HarnessResult> }

function usageFrom(value: unknown): Usage {
	if (!value || typeof value !== "object") return {}; const o = value as Record<string, unknown>; const n = (key: string) => typeof o[key] === "number" ? o[key] as number : undefined;
	return { inputTokens: n("input") ?? n("inputTokens"), outputTokens: n("output") ?? n("outputTokens"), cacheReadTokens: n("cacheRead") ?? n("cacheReadTokens"), cacheWriteTokens: n("cacheWrite") ?? n("cacheWriteTokens"), cost: n("cost") ?? (o.cost && typeof o.cost === "object" && typeof (o.cost as Record<string, unknown>).total === "number" ? (o.cost as Record<string, number>).total : undefined) };
}
function addUsage(current: Usage, next: Usage): Usage { return { inputTokens: (current.inputTokens ?? 0) + (next.inputTokens ?? 0), outputTokens: (current.outputTokens ?? 0) + (next.outputTokens ?? 0), cacheReadTokens: (current.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0), cacheWriteTokens: (current.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0), cost: (current.cost ?? 0) + (next.cost ?? 0) }; }
function environment(workspace: string): NodeJS.ProcessEnv {
	const keep = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "SHELL", "USER", "LOGNAME", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"];
	const env: NodeJS.ProcessEnv = {}; for (const key of keep) if (process.env[key]) env[key] = process.env[key]; env.PI_EVAL_WORKSPACE = workspace; env.PI_OFFLINE = "1"; return env;
}

export async function compileFixtureContext(workspace: string): Promise<string> {
	const { readdir } = await import("node:fs/promises"); const files: string[] = [];
	async function walk(dir: string): Promise<void> { const entries = await readdir(dir, { withFileTypes: true }); entries.sort((a, b) => a.name.localeCompare(b.name)); for (const entry of entries) { if (entry.name === ".git" || entry.name === "node_modules") continue; const absolute = path.join(dir, entry.name); if (entry.isDirectory()) await walk(absolute); else if (entry.isFile() && (entry.name === "AGENTS.md" || entry.name === "CLAUDE.md")) files.push(absolute); } }
	await walk(workspace); files.sort((a, b) => { const depth = (file: string) => path.relative(workspace, file).split(path.sep).length; return depth(a) - depth(b) || a.localeCompare(b); }); const parts: string[] = []; for (const file of files) parts.push(`<fixture-context path="${path.relative(workspace, file).split(path.sep).join("/")}">\n${await readFile(file, "utf8")}\n</fixture-context>`); return parts.join("\n\n");
}

export async function executePiCell(cell: ResolvedCell, scenario: ResolvedScenario & { prompt: string }, options: HarnessExecutionOptions): Promise<HarnessResult> {
	const started = Date.now(); const traceFile = path.join(options.runDir, "artifacts", "cells", cell.id, "trace.redacted.jsonl"); await mkdir(path.dirname(traceFile), { recursive: true }); await writeFile(traceFile, "", { mode: 0o600 });
	const extensionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../extensions/evals/skill-eval/runtime/eval-guard.ts"); const context = await compileFixtureContext(options.workspace);
	const system = ["You are executing one isolated skill evaluation cell.", "Work only inside the current workspace. Do not inspect credentials, parent directories, or external repositories. Do not push or contact remotes.", context ? `Fixture-owned context follows:\n${context}` : ""].filter(Boolean).join("\n\n");
	const args = ["--mode", "json", "--print", "--no-session", "--no-extensions", "--extension", extensionPath, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--approve", "--model", cell.target.model, "--thinking", cell.target.thinking, "--tools", scenario.tools.join(","), "--system-prompt", system]; if (options.skillDirectory) args.push("--skill", options.skillDirectory); args.push(scenario.prompt);
	return await new Promise((resolve) => {
		const child = spawn("pi", args, { cwd: options.workspace, detached: process.platform !== "win32", env: { ...environment(options.workspace), PI_EVAL_NETWORK: scenario.permissions.network ? "1" : "0", PI_EVAL_SKILL_ROOT: options.skillDirectory, PI_EVAL_MODE: scenario.permissions.mode }, stdio: ["ignore", "pipe", "pipe"] }); options.onPid?.(child.pid ?? -1);
		let pending = "", stderr = "", usage: Usage = {}, settled = false, childClosed = false, writeChain = Promise.resolve(), traceBytes = 0, traceTruncated = false; const toolNames: string[] = []; const roots = [options.workspace, options.runDir, process.env.HOME ?? ""];
		const finish = async (code: number, error?: string) => { if (settled) return; settled = true; options.signal.removeEventListener("abort", abort); if (pending.trim()) queueLine(pending); if (stderr.trim()) queueLine(JSON.stringify({ type: "harness_stderr", text: redactText(stderr, roots) })); await writeChain; resolve({ code, durationMs: Date.now() - started, usage, traceFile, toolNames, stderr: redactText(stderr, roots), error }); };
		const appendLine = async (line: string) => { try { const event = JSON.parse(line) as Record<string, unknown>; const type = event.type; if (type === "tool_execution_start" && typeof event.toolName === "string") { toolNames.push(event.toolName); await options.onEvent?.({ type: "tool", toolName: event.toolName }); } if (type === "message_end" && event.message && typeof event.message === "object" && (event.message as Record<string, unknown>).role === "assistant" && (event.message as Record<string, unknown>).usage) usage = addUsage(usage, usageFrom((event.message as Record<string, unknown>).usage)); const serialized = `${JSON.stringify(redactValue(event, roots))}\n`; if (traceBytes + Buffer.byteLength(serialized) <= ARTIFACT_LIMITS.traceBytes) { await (await import("node:fs/promises")).appendFile(traceFile, serialized); traceBytes += Buffer.byteLength(serialized); } else if (!traceTruncated) { traceTruncated = true; await (await import("node:fs/promises")).appendFile(traceFile, `${JSON.stringify({ type: "trace_truncated", maximumBytes: ARTIFACT_LIMITS.traceBytes })}\n`); } } catch { const serialized = `${JSON.stringify({ type: "unparsed", text: redactText(line, roots) })}\n`; if (traceBytes + Buffer.byteLength(serialized) <= ARTIFACT_LIMITS.traceBytes) { await (await import("node:fs/promises")).appendFile(traceFile, serialized); traceBytes += Buffer.byteLength(serialized); } } };
		const queueLine = (line: string) => { writeChain = writeChain.then(() => appendLine(line)); };
		child.stdout.on("data", (chunk: Buffer) => { const text = chunk.toString("utf8"); options.onOutput?.("stdout", text); pending += text; const lines = pending.split("\n"); pending = lines.pop() ?? ""; for (const line of lines) if (line.trim()) queueLine(line); });
		child.stderr.on("data", (chunk: Buffer) => { const text = chunk.toString("utf8"); options.onOutput?.("stderr", text); stderr = (stderr + text).slice(-2 * 1024 * 1024); });
		const signalChild = (signal: NodeJS.Signals) => { if (childClosed) return; try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* process already exited */ } };
		const abort = () => { signalChild("SIGTERM"); setTimeout(() => signalChild("SIGKILL"), 2_000).unref(); void finish(-1, "Cell cancelled"); }; options.signal.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => { signalChild("SIGTERM"); setTimeout(() => signalChild("SIGKILL"), 2_000).unref(); void finish(-1, `Cell timed out after ${scenario.limits.scenarioTimeout}ms`); }, scenario.limits.scenarioTimeout); timer.unref();
		child.on("error", (error) => { clearTimeout(timer); void finish(-1, error.message); }); child.on("close", (code) => { childClosed = true; clearTimeout(timer); void finish(code ?? -1, code === 0 ? undefined : `Pi exited with code ${code ?? -1}`); });
	});
}

export const piHarnessAdapter: HarnessAdapter = { harness: "pi", execute: executePiCell };
