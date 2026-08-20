import { appendFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CellState, ControlRequest, ControllerInfo, Registry, RegistryEntry, ResolvedPlan, RunEvent, RunState } from "./domain.ts";
import { RUNNER_VERSION } from "./domain.ts";
import { atomicWriteJson, readJson, runCommand } from "./filesystem.ts";

export function storageRoot(): string { return process.env.PI_SKILL_EVAL_HOME ?? path.join(os.homedir(), ".pi", "agent", "skill-evals"); }
export function runsRoot(): string { return path.join(storageRoot(), "runs"); }
export function runDirectory(runId: string): string { return path.join(runsRoot(), runId); }
export const runPaths = (runDir: string) => ({ events: path.join(runDir, "events.jsonl"), state: path.join(runDir, "state.json"), plan: path.join(runDir, "resolved-plan.json"), controller: path.join(runDir, "controller.json"), control: path.join(runDir, "control"), artifacts: path.join(runDir, "artifacts"), workspaces: path.join(runDir, "workspaces"), reportJson: path.join(runDir, "report.json"), reportMarkdown: path.join(runDir, "report.md") });

export async function ensureStorage(): Promise<void> { await mkdir(runsRoot(), { recursive: true, mode: 0o700 }); const registry = path.join(storageRoot(), "registry.json"); try { await stat(registry); } catch { await atomicWriteJson(registry, { schemaVersion: 1, runs: [] } satisfies Registry); } }
export async function readRegistry(): Promise<Registry> { await ensureStorage(); return await readJson<Registry>(path.join(storageRoot(), "registry.json")); }
export async function writeRegistry(registry: Registry): Promise<void> { await atomicWriteJson(path.join(storageRoot(), "registry.json"), registry); }
export async function readState(runId: string): Promise<RunState> { const paths = runPaths(runDirectory(runId)); let state = await readJson<RunState>(paths.state); try { const lines = (await readFile(paths.events, "utf8")).split("\n").filter(Boolean); for (const line of lines) { const event = JSON.parse(line) as RunEvent; if (event.sequence > state.sequence) state = applyEvent(state, event); } } catch { /* a partial trailing event is ignored until a writer/finalizer repairs projection */ } return state; }
export async function readPlan(runId: string): Promise<ResolvedPlan> { return await readJson<ResolvedPlan>(runPaths(runDirectory(runId)).plan); }

export function initialState(plan: ResolvedPlan): RunState {
	const cells: Record<string, CellState> = {}; const blocks: RunState["blocks"] = {};
	for (const block of plan.blocks) { blocks[block.id] = { id: block.id, status: "pending", cellIds: block.cells.map((c) => c.id) }; for (const cell of block.cells) cells[cell.id] = { id: cell.id, blockId: block.id, scenarioId: cell.scenarioId, arm: cell.arm, target: `${cell.target.harness}:${cell.target.model}:${cell.target.thinking}`, repetition: cell.repetition, status: "pending", checks: [], isolationLevel: plan.isolationLevel }; }
	return { schemaVersion: 1, runId: plan.runId, name: plan.comparisonName, lifecycle: "preparing", verdict: "pending", createdAt: plan.createdAt, updatedAt: plan.createdAt, sequence: 0, profile: plan.profileName, isolationLevel: plan.isolationLevel, blocks, cells, completedBlocks: 0, completedCells: 0, totalBlocks: plan.blocks.length, totalCells: Object.keys(cells).length, evaluationCost: 0, acceptance: [], warnings: plan.warnings };
}

export function applyEvent(state: RunState, event: RunEvent): RunState {
	const next: RunState = structuredClone(state); next.sequence = event.sequence; next.updatedAt = event.timestamp; const data = event.data;
	switch (event.type) {
		case "run_started": next.lifecycle = "running"; next.startedAt = event.timestamp; break;
		case "pause_requested": next.lifecycle = "pause_requested"; break;
		case "run_paused": next.lifecycle = "paused"; break;
		case "run_resumed": next.lifecycle = "running"; break;
		case "cancel_requested": next.lifecycle = "cancelling"; break;
		case "block_started": { const id = String(data.blockId); next.activeBlockId = id; if (next.blocks[id]) next.blocks[id]!.status = "running"; break; }
		case "block_completed": { const id = String(data.blockId); if (next.blocks[id]?.status !== "completed") next.completedBlocks++; if (next.blocks[id]) next.blocks[id]!.status = "completed"; if (next.activeBlockId === id) delete next.activeBlockId; break; }
		case "cell_started": { const cell = next.cells[String(data.cellId)]; if (cell) { cell.status = "running"; cell.startedAt = event.timestamp; } break; }
		case "cell_tool": { const cell = next.cells[String(data.cellId)]; if (cell) cell.lastTool = String(data.toolName); break; }
		case "check_completed": { const cell = next.cells[String(data.cellId)]; if (cell) cell.checks.push(data.result as never); break; }
		case "cell_completed": { const cell = next.cells[String(data.cellId)]; if (cell) { if (["pending", "running"].includes(cell.status)) next.completedCells++; Object.assign(cell, data.patch as Partial<CellState>); cell.endedAt = event.timestamp; if (cell.usage?.cost) next.evaluationCost += cell.usage.cost; } break; }
		case "acceptance_evaluated": next.acceptance = data.results as RunState["acceptance"]; next.verdict = data.verdict as RunState["verdict"]; break;
		case "run_completed": next.lifecycle = "completed"; next.endedAt = event.timestamp; break;
		case "run_cancelled": next.lifecycle = "cancelled"; next.endedAt = event.timestamp; next.verdict = next.verdict === "fail" ? "fail" : "incomplete"; break;
		case "run_interrupted": next.lifecycle = "interrupted"; next.endedAt = event.timestamp; next.verdict = data.verdict === "fail" ? "fail" : "incomplete"; next.lastError = typeof data.error === "string" ? data.error : undefined; break;
	}
	return next;
}

export class EventWriter {
	private state: RunState;
	private queue: Promise<void> = Promise.resolve();
	constructor(private readonly runDir: string, state: RunState) { this.state = state; }
	get current(): RunState { return this.state; }
	emit(type: string, data: Record<string, unknown> = {}): Promise<RunEvent> {
		let result!: RunEvent; const operation = this.queue.then(async () => { const event: RunEvent = { schemaVersion: 1, sequence: this.state.sequence + 1, eventId: randomUUID(), runId: this.state.runId, timestamp: new Date().toISOString(), type, data }; await appendFile(runPaths(this.runDir).events, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 }); this.state = applyEvent(this.state, event); await atomicWriteJson(runPaths(this.runDir).state, this.state); result = event; }); this.queue = operation.catch(() => undefined); return operation.then(() => result);
	}
}

export async function initializeRun(plan: ResolvedPlan): Promise<void> {
	await ensureStorage(); const runDir = runDirectory(plan.runId); const paths = runPaths(runDir); await mkdir(paths.artifacts, { recursive: true }); await mkdir(paths.control, { recursive: true }); await mkdir(paths.workspaces, { recursive: true }); await writeFile(paths.events, "", { mode: 0o600 }); await atomicWriteJson(paths.plan, plan); await atomicWriteJson(paths.state, initialState(plan));
}
export async function reserveGlobalRun(plan: ResolvedPlan): Promise<void> {
	await ensureStorage(); const lock = path.join(storageRoot(), "active.lock"); try { await mkdir(lock, { mode: 0o700 }); } catch { const registry = await readRegistry(); throw new Error(`Another skill evaluation is active${registry.activeRunId ? `: ${registry.activeRunId}` : ""}`); }
	try { await writeFile(path.join(lock, "run-id"), plan.runId, { mode: 0o600 }); const registry = await readRegistry(); const entry: RegistryEntry = { runId: plan.runId, name: plan.comparisonName, directory: runDirectory(plan.runId), lifecycle: "preparing", verdict: "pending", createdAt: plan.createdAt, updatedAt: plan.createdAt }; registry.activeRunId = plan.runId; registry.runs = [entry, ...registry.runs.filter((r) => r.runId !== plan.runId)]; await writeRegistry(registry); } catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
}
export async function updateRegistryFromState(state: RunState): Promise<void> { const registry = await readRegistry(); const existing = registry.runs.find((r) => r.runId === state.runId); const entry: RegistryEntry = { runId: state.runId, name: state.name, directory: runDirectory(state.runId), lifecycle: state.lifecycle, verdict: state.verdict, createdAt: state.createdAt, updatedAt: state.updatedAt }; registry.runs = [entry, ...registry.runs.filter((r) => r.runId !== state.runId)]; if (existing || registry.activeRunId === state.runId) { if (["completed", "cancelled", "interrupted"].includes(state.lifecycle)) delete registry.activeRunId; else registry.activeRunId = state.runId; } await writeRegistry(registry); }
export async function releaseGlobalRun(state: RunState): Promise<void> { await updateRegistryFromState(state); const lock = path.join(storageRoot(), "active.lock"); try { const owner = (await readFile(path.join(lock, "run-id"), "utf8")).trim(); if (owner === state.runId) await rm(lock, { recursive: true, force: true }); } catch { /* already released */ } }

export async function writeController(runId: string, info: ControllerInfo): Promise<void> { await atomicWriteJson(runPaths(runDirectory(runId)).controller, info); }
export async function readController(runId: string): Promise<ControllerInfo> { return await readJson<ControllerInfo>(runPaths(runDirectory(runId)).controller); }
export async function controllerHealth(runId: string): Promise<"live" | "stale" | "missing"> { try { const info = await readJson<ControllerInfo>(runPaths(runDirectory(runId)).controller); const age = Date.now() - Date.parse(info.heartbeatAt); if (age > 15_000) return "stale"; try { process.kill(info.pid, 0); return "live"; } catch { return "stale"; } } catch { return "missing"; } }
export async function submitControl(runId: string, action: ControlRequest["action"]): Promise<ControlRequest> { const request: ControlRequest = { schemaVersion: 1, id: randomUUID(), runId, action, requestedAt: new Date().toISOString() }; const dir = runPaths(runDirectory(runId)).control; await mkdir(dir, { recursive: true }); await atomicWriteJson(path.join(dir, `${Date.now()}-${request.id}.json`), request); return request; }
export async function consumeControls(runId: string): Promise<ControlRequest[]> { const dir = runPaths(runDirectory(runId)).control; const result: ControlRequest[] = []; let files: string[] = []; try { files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort(); } catch { return result; } for (const file of files) { const absolute = path.join(dir, file); try { result.push(await readJson<ControlRequest>(absolute)); await rm(absolute); } catch { await rm(absolute, { force: true }); } } return result; }
export async function resolveRunId(requested?: string): Promise<string> { const registry = await readRegistry(); if (requested) { const exact = registry.runs.find((r) => r.runId === requested); if (exact) return exact.runId; const partial = registry.runs.filter((r) => r.runId.startsWith(requested)); if (partial.length === 1) return partial[0]!.runId; throw new Error(`Run not found or ambiguous: ${requested}`); } if (registry.activeRunId) return registry.activeRunId; if (registry.runs[0]) return registry.runs[0].runId; throw new Error("No skill evaluation runs found"); }
export async function abandonPreparingRun(runId: string): Promise<void> { const lock = path.join(storageRoot(), "active.lock"); try { const owner = (await readFile(path.join(lock, "run-id"), "utf8")).trim(); if (owner === runId) await rm(lock, { recursive: true, force: true }); } catch { /* no reservation */ } const registry = await readRegistry(); registry.runs = registry.runs.filter((run) => run.runId !== runId); if (registry.activeRunId === runId) delete registry.activeRunId; await writeRegistry(registry); await rm(runDirectory(runId), { recursive: true, force: true }); }
export async function deleteRun(runId: string): Promise<void> { const state = await readState(runId); if (!["completed", "cancelled", "interrupted"].includes(state.lifecycle)) throw new Error("Active runs cannot be deleted"); await rm(runDirectory(runId), { recursive: true, force: true }); const registry = await readRegistry(); registry.runs = registry.runs.filter((r) => r.runId !== runId); if (registry.activeRunId === runId) delete registry.activeRunId; await writeRegistry(registry); }

async function terminateMatchingProcess(pid: number, fragments: string[]): Promise<void> { const result = await runCommand("ps", ["-p", String(pid), "-o", "command="], { timeout: 5_000 }).catch(() => undefined); if (!result || result.code !== 0 || !fragments.every((fragment) => result.stdout.includes(fragment))) return; try { const target = process.platform === "win32" ? pid : -pid; process.kill(target, "SIGTERM"); await new Promise((resolve) => setTimeout(resolve, 250)); try { process.kill(pid, 0); process.kill(target, "SIGKILL"); } catch { /* process exited */ } } catch { /* process already exited */ } }

export async function finalizeInterrupted(runId: string, reason: string): Promise<RunState> {
	const state = await readState(runId); if (["completed", "cancelled", "interrupted"].includes(state.lifecycle)) return state;
	const lock = path.join(storageRoot(), "active.lock"); let owner: string | undefined; try { owner = (await readFile(path.join(lock, "run-id"), "utf8")).trim(); } catch { try { await mkdir(lock, { mode: 0o700 }); await writeFile(path.join(lock, "run-id"), runId, { mode: 0o600 }); owner = runId; } catch { try { owner = (await readFile(path.join(lock, "run-id"), "utf8")).trim(); } catch { /* lock is unreadable */ } } } if (owner && owner !== runId) throw new Error(`Global evaluation lock belongs to ${owner}`); if (!owner) throw new Error("Cannot acquire the global evaluation lock for finalization");
	try { const controller = await readJson<ControllerInfo>(runPaths(runDirectory(runId)).controller); if (controller.pid !== process.pid) await terminateMatchingProcess(controller.pid, ["worker-entry.ts", runId]); for (const pid of controller.childPids) await terminateMatchingProcess(pid, ["pi", "--mode", "json"]); } catch { /* no controller metadata */ }
	const writer = new EventWriter(runDirectory(runId), state);
	for (const cell of Object.values(writer.current.cells)) if (cell.status === "running" || cell.status === "pending") await writer.emit("cell_completed", { cellId: cell.id, patch: { status: cell.status === "running" ? "errored" : "not_run", error: reason } });
	await writer.emit("run_interrupted", { error: reason, verdict: writer.current.verdict === "fail" ? "fail" : "incomplete" }); await releaseGlobalRun(writer.current); return writer.current;
}

export function workerInfo(): ControllerInfo { const now = new Date().toISOString(); return { pid: process.pid, workerVersion: RUNNER_VERSION, startedAt: now, heartbeatAt: now, childPids: [] }; }
