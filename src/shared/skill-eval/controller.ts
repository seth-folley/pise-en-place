import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ControllerInfo, ResolvedCell, ResolvedPlan, ResolvedScenario } from "./domain.ts";
import { relativeArtifact } from "./domain.ts";
import { archiveDirectory, extractArchive } from "./filesystem.ts";
import { captureDiff, evaluateAcceptance, gradeCheck } from "./grading.ts";
import { piHarnessAdapter } from "./harness.ts";
import { LiveOutputServer, liveOutputSocketPath } from "./live-output.ts";
import { writeReports } from "./reporting.ts";
import { redactText } from "./security.ts";
import { consumeControls, EventWriter, readPlan, readState, releaseGlobalRun, runDirectory, runPaths, updateRegistryFromState, workerInfo, writeController } from "./storage.ts";

interface PreparedScenario { scenario: ResolvedScenario & { prompt: string }; artifact: string; digest: string }

async function prepareScenarios(runDir: string, plan: ResolvedPlan, writer: EventWriter, signal: AbortSignal): Promise<Map<string, PreparedScenario>> {
	const prepared = new Map<string, PreparedScenario>();
	for (const scenario of plan.scenarios) {
		if (signal.aborted) throw new Error("Run cancelled before fixture dispatch"); const prompt = await readFile(path.resolve(runDir, scenario.promptArtifact), "utf8"), artifact = path.resolve(runDir, scenario.fixtureArtifact); prepared.set(scenario.id, { scenario: { ...scenario, prompt }, artifact, digest: scenario.fixtureDigest }); await writer.emit("fixture_prepared", { scenarioId: scenario.id, digest: scenario.fixtureDigest, artifact: scenario.fixtureManifestArtifact });
	}
	return prepared;
}

export async function runController(runId: string): Promise<void> {
	const runDir = runDirectory(runId), plan = await readPlan(runId); let state = await readState(runId); const writer = new EventWriter(runDir, state); const info = workerInfo(); const liveOutput = new LiveOutputServer(liveOutputSocketPath(runId)); await liveOutput.start(); let heartbeat: NodeJS.Timeout | undefined; const active = new Map<string, AbortController>(); const runAbort = new AbortController(); let pauseRequested = false, cancelled = false;
	const updateHeartbeat = async () => { info.heartbeatAt = new Date().toISOString(); await writeController(runId, info); };
	const processControls = async () => { for (const request of await consumeControls(runId)) { if (request.action === "cancel" && !cancelled) { cancelled = true; pauseRequested = false; await writer.emit("cancel_requested", { requestId: request.id }); runAbort.abort(); for (const controller of active.values()) controller.abort(); } else if (request.action === "pause" && !pauseRequested && (writer.current.lifecycle === "running" || writer.current.lifecycle === "preparing")) { pauseRequested = true; await writer.emit("pause_requested", { requestId: request.id }); } else if (request.action === "resume" && pauseRequested) { pauseRequested = false; await writer.emit("run_resumed", { requestId: request.id }); } } };
	const controlTimer = setInterval(() => { void processControls(); }, 500); controlTimer.unref();
	try {
		await updateHeartbeat(); heartbeat = setInterval(() => { void updateHeartbeat(); }, 5_000); heartbeat.unref(); await updateRegistryFromState(writer.current);
		const prepared = await prepareScenarios(runDir, plan, writer, runAbort.signal); await processControls(); if (!cancelled) await writer.emit("run_started");
		for (const block of plan.blocks) {
			await processControls(); if (cancelled) break;
			while (pauseRequested && !cancelled) { if (writer.current.lifecycle !== "paused") await writer.emit("run_paused"); await new Promise((resolve) => setTimeout(resolve, 300)); await processControls(); }
			if (cancelled) break;
			if (plan.profile.limits?.maxCost !== undefined && writer.current.evaluationCost >= plan.profile.limits.maxCost) { await writer.emit("budget_exhausted", { observedCost: writer.current.evaluationCost, maximum: plan.profile.limits.maxCost }); break; }
			await writer.emit("block_started", { blockId: block.id }); const queue = [...block.cells];
			while (queue.length && !cancelled) {
				await processControls(); if (pauseRequested) { if (writer.current.lifecycle !== "paused") await writer.emit("run_paused"); while (pauseRequested && !cancelled) { await new Promise((resolve) => setTimeout(resolve, 300)); await processControls(); } }
				const batch = queue.splice(0, plan.profile.maxConcurrency); await Promise.all(batch.map((cell) => executeCell(runDir, plan, cell, prepared.get(cell.scenarioId)!, writer, active, liveOutput, (pid, running) => { info.childPids = running ? [...new Set([...info.childPids, pid])] : info.childPids.filter((value) => value !== pid); void updateHeartbeat(); })));
				if (plan.profile.limits?.maxCost !== undefined && writer.current.evaluationCost >= plan.profile.limits.maxCost) { await writer.emit("budget_exhausted", { observedCost: writer.current.evaluationCost, maximum: plan.profile.limits.maxCost }); break; }
			}
			if (!cancelled && block.cells.every((cell) => !["pending", "running"].includes(writer.current.cells[cell.id]!.status))) await writer.emit("block_completed", { blockId: block.id });
			if (plan.profile.limits?.maxCost !== undefined && writer.current.evaluationCost >= plan.profile.limits.maxCost) break;
		}
		if (cancelled) {
			for (const cell of Object.values(writer.current.cells).filter((c) => c.status === "pending")) await writer.emit("cell_completed", { cellId: cell.id, patch: { status: "cancelled", error: "Run cancelled before dispatch" } });
			const acceptance = evaluateAcceptance(plan, writer.current); await writer.emit("acceptance_evaluated", acceptance); await writer.emit("run_cancelled");
		} else {
			for (const cell of Object.values(writer.current.cells).filter((c) => c.status === "pending")) await writer.emit("cell_completed", { cellId: cell.id, patch: { status: "not_run", error: "Not dispatched because the evaluation budget was exhausted" } });
			const acceptance = evaluateAcceptance(plan, writer.current); await writer.emit("acceptance_evaluated", acceptance); await writer.emit("run_completed");
		}
		await writeReports(runDir, plan, writer.current);
	} catch (error) {
		const message = redactText(error instanceof Error ? error.stack ?? error.message : String(error), [runDir, process.env.HOME ?? ""]); for (const controller of active.values()) controller.abort();
		for (const cell of Object.values(writer.current.cells).filter((c) => c.status === "running" || c.status === "pending")) await writer.emit("cell_completed", { cellId: cell.id, patch: { status: cancelled ? "cancelled" : cell.status === "running" ? "errored" : "not_run", error: message } });
		const acceptance = evaluateAcceptance(plan, writer.current); await writer.emit("acceptance_evaluated", acceptance); if (cancelled) await writer.emit("run_cancelled"); else await writer.emit("run_interrupted", { error: message, verdict: acceptance.verdict === "fail" ? "fail" : "incomplete" }); await writeReports(runDir, plan, writer.current).catch(() => undefined);
	} finally {
		await liveOutput.close();
		clearInterval(controlTimer); if (heartbeat) clearInterval(heartbeat); await rm(runPaths(runDir).workspaces, { recursive: true, force: true }); const { readdir } = await import("node:fs/promises"); for (const file of await readdir(runPaths(runDir).artifacts).catch(() => [])) if (file.startsWith("prepared-") && file.endsWith(".tgz")) await rm(path.join(runPaths(runDir).artifacts, file), { force: true }); await releaseGlobalRun(writer.current); await updateHeartbeat().catch(() => undefined);
	}
}

async function executeCell(runDir: string, plan: ResolvedPlan, cell: ResolvedCell, prepared: PreparedScenario, writer: EventWriter, active: Map<string, AbortController>, liveOutput: LiveOutputServer, onPid: (pid: number, running: boolean) => void): Promise<void> {
	const workspace = path.resolve(runDir, cell.workspace), skillDirectory = cell.arm === "control" ? undefined : `${workspace}.skill`, gradingArchive = `${workspace}.post-agent.tgz`; const controller = new AbortController(); let childPid: number | undefined; active.set(cell.id, controller); await writer.emit("cell_started", { cellId: cell.id }); const started = Date.now();
	try {
		await extractArchive(prepared.artifact, workspace); if (skillDirectory) await extractArchive(path.resolve(runDir, cell.skillArtifact!), skillDirectory);
		const harness = await piHarnessAdapter.execute(cell, prepared.scenario, { runDir, workspace, skillDirectory, signal: controller.signal, onEvent: async (event) => { if (event.type === "tool") await writer.emit("cell_tool", { cellId: cell.id, toolName: event.toolName }); }, onPid: (pid) => { if (pid > 0) { childPid = pid; onPid(pid, true); } }, onOutput: (stream, text) => liveOutput.publish({ cellId: cell.id, stream, text }) });
		if (controller.signal.aborted) { await writer.emit("cell_completed", { cellId: cell.id, patch: { status: "cancelled", durationMs: Date.now() - started, usage: harness.usage, traceArtifact: relativeArtifact(runDir, harness.traceFile), error: "Run cancelled" } }); return; }
		const diffArtifact = path.join(runDir, "artifacts", "cells", cell.id, "workspace.patch"); const diff = await captureDiff(workspace, diffArtifact); await archiveDirectory(workspace, gradingArchive); const checks = [];
		for (const [index, check] of prepared.scenario.checks.entries()) { const checkWorkspace = `${workspace}.check-${index}`; await extractArchive(gradingArchive, checkWorkspace); const checkArtifact = check.type === "command" ? path.join(runDir, "artifacts", "cells", cell.id, `check-${check.id}.redacted.log`) : undefined; const result = await gradeCheck(check, { workspace: checkWorkspace, traceFile: harness.traceFile, diff, timeout: prepared.scenario.limits.checkTimeout, artifact: checkArtifact }); if (result.artifact) result.artifact = relativeArtifact(runDir, result.artifact); await rm(checkWorkspace, { recursive: true, force: true }); checks.push(result); await writer.emit("check_completed", { cellId: cell.id, result }); }
		const criticalFailed = checks.some((check) => check.severity === "critical" && check.status !== "passed"); const status = harness.error ? "errored" : criticalFailed ? "failed" : "passed"; await writer.emit("cell_completed", { cellId: cell.id, patch: { status, durationMs: Date.now() - started, usage: harness.usage, traceArtifact: relativeArtifact(runDir, harness.traceFile), diffArtifact: relativeArtifact(runDir, diffArtifact), error: harness.error } });
	} catch (error) { await writer.emit("cell_completed", { cellId: cell.id, patch: { status: controller.signal.aborted ? "cancelled" : "errored", durationMs: Date.now() - started, error: redactText(error instanceof Error ? error.message : String(error), [workspace, runDir, process.env.HOME ?? ""]) } }); }
	finally { active.delete(cell.id); if (childPid) onPid(childPid, false); await rm(workspace, { recursive: true, force: true }); if (skillDirectory) await rm(skillDirectory, { recursive: true, force: true }); await rm(gradingArchive, { force: true }); for (let index = 0; index < prepared.scenario.checks.length; index++) await rm(`${workspace}.check-${index}`, { recursive: true, force: true }); }
}
