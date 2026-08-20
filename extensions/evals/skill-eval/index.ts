import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { closeSync, openSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SkillEvalDashboard } from "./dashboard.ts";
import { ValidationError } from "../../../src/shared/skill-eval/domain.ts";
import { formatPlanPreview, resolveComparison } from "../../../src/shared/skill-eval/resolver.ts";
import { writeReports } from "../../../src/shared/skill-eval/reporting.ts";
import { abandonPreparingRun, controllerHealth, deleteRun, finalizeInterrupted, initializeRun, readPlan, readRegistry, readState, reserveGlobalRun, resolveRunId, runDirectory, runPaths, submitControl } from "../../../src/shared/skill-eval/storage.ts";

const require = createRequire(import.meta.url); const workerEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../src/shared/skill-eval/worker-entry.ts");
function tokens(args: string): string[] { return args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((value) => value.replace(/^("|')|("|')$/g, "")) ?? []; }
function errorMessage(error: unknown): string { return error instanceof ValidationError ? error.issues.map((issue) => `• ${issue}`).join("\n") : error instanceof Error ? error.message : String(error); }
function usage(): string { return ["/skill-eval", "/skill-eval validate <comparison>", "/skill-eval run <comparison> [--profile smoke] [-b]", "/skill-eval status [run-id]", "/skill-eval monitor [run-id]", "/skill-eval pause|resume|cancel [run-id]", "/skill-eval report [run-id]", "/skill-eval delete <run-id>"].join("\n"); }
function statusText(state: Awaited<ReturnType<typeof readState>>, health: string): string { if (["completed", "cancelled", "interrupted"].includes(state.lifecycle)) health = "terminal"; const failures = Object.values(state.cells).filter((cell) => cell.status === "failed" || cell.status === "errored"); return [`Skill evaluation ${state.runId}`, `Lifecycle: ${state.lifecycle}`, `Verdict: ${state.verdict}`, `Controller: ${health}`, `Progress: ${state.completedBlocks}/${state.totalBlocks} blocks; ${state.completedCells}/${state.totalCells} cells`, `Observed cost: $${state.evaluationCost.toFixed(4)}`, `Isolation: ${state.isolationLevel}`, failures.length ? `Failures/errors: ${failures.length}` : "Failures/errors: none", `Directory: ${runDirectory(state.runId)}`].join("\n"); }
async function launch(runId: string): Promise<void> { const tsx = require.resolve("tsx/cli"); const log = path.join(runDirectory(runId), "controller.log"); const fd = openSync(log, "a", 0o600); try { const child = spawn(process.execPath, [tsx, workerEntry, runId], { detached: true, stdio: ["ignore", fd, fd], cwd: path.dirname(workerEntry), env: process.env }); await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }); child.unref(); } finally { closeSync(fd); } }
async function maybeFinalize(runId: string, ctx: ExtensionContext): Promise<boolean> { const health = await controllerHealth(runId); const state = await readState(runId); if (health === "live" || (health === "missing" && Date.now() - Date.parse(state.createdAt) < 15_000) || ["completed", "cancelled", "interrupted"].includes(state.lifecycle)) return false; const confirmed = await ctx.ui.confirm("Finalize interrupted evaluation?", `${runId}\nThe controller is ${health}. Remaining cells will not resume; partial evidence will be preserved.`); if (!confirmed) return false; const final = await finalizeInterrupted(runId, `Controller ${health}; finalized by user`); await writeReports(runDirectory(runId), await readPlan(runId), final); ctx.ui.notify("Run finalized as interrupted.", "warning"); return true; }

export default function skillEvalExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => { try { const registry = await readRegistry(); if (!registry.activeRunId) return; const health = await controllerHealth(registry.activeRunId); ctx.ui.notify(health === "live" ? `Skill evaluation ${registry.activeRunId} is active. Use /skill-eval monitor to follow it.` : `Skill evaluation ${registry.activeRunId} has a ${health} controller. Use /skill-eval status to finalize it.`, health === "live" ? "info" : "warning"); } catch { /* startup discovery is best effort */ } });
	pi.registerCommand("skill-eval", {
		description: "Validate, run, and monitor durable skill evaluations",
		handler: async (rawArgs, ctx) => {
			try {
				let argv = tokens(rawArgs.trim());
				if (!argv.length) { if (!ctx.hasUI) { ctx.ui.notify(usage(), "info"); return; } const action = await ctx.ui.select("Skill evaluation", ["Run a comparison", "Validate a comparison", "Monitor latest run", "Show latest status", "Open latest report"]); if (!action) return; if (action.startsWith("Run") || action.startsWith("Validate")) { const file = await ctx.ui.input("Comparison YAML path", "evals/<skill>/comparisons/<comparison>.yaml"); if (!file) return; argv = [action.startsWith("Run") ? "run" : "validate", file]; } else if (action.startsWith("Monitor")) argv = ["monitor"]; else if (action.startsWith("Show")) argv = ["status"]; else argv = ["report"]; }
				const [command, ...rest] = argv;
				if (command === "help" || command === "--help" || command === "-h") { ctx.ui.notify(usage(), "info"); return; }
				if (command === "validate" || command === "run") {
					const file = rest[0]; if (!file) throw new Error(`Usage: /skill-eval ${command} <comparison> [--profile <name>]${command === "run" ? " [-b]" : ""}`); const profileIndex = rest.indexOf("--profile"); const profile = profileIndex >= 0 ? rest[profileIndex + 1] : undefined; const background = rest.includes("-b"); if (profileIndex >= 0 && !profile) throw new Error("--profile requires a value"); if (command === "validate" && background) throw new Error("-b applies only to /skill-eval run");
					if (command === "run") { const registry = await readRegistry(); if (registry.activeRunId) throw new Error(`Another skill evaluation is active: ${registry.activeRunId}. Use /skill-eval status to inspect or finalize it.`); }
					ctx.ui.notify("Resolving refs, preparing fixtures, and validating capabilities…", "info"); const plan = await resolveComparison(path.resolve(ctx.cwd, file), { profile, onFixturePreparationProgress: (progress) => ctx.ui.notify(`Fixture ${progress.scenarioId}: ${progress.message}`, progress.status === "failed" ? "error" : "info") });
					if (command === "validate") { ctx.ui.notify(`${formatPlanPreview(plan)}\n\nValidation passed. No run was started.`, "info"); await rm(runDirectory(plan.runId), { recursive: true, force: true }); return; }
					const approved = await ctx.ui.confirm("Start detached skill evaluation?", formatPlanPreview(plan)); if (!approved) { await rm(runDirectory(plan.runId), { recursive: true, force: true }); ctx.ui.notify("Evaluation cancelled before approval.", "info"); return; }
					try { await initializeRun(plan); await reserveGlobalRun(plan); await launch(plan.runId); } catch (error) { await abandonPreparingRun(plan.runId); throw error; }
					if (background || !ctx.hasUI) { ctx.ui.notify(`Started ${plan.runId}. It will continue after Pi exits.\nUse /skill-eval monitor ${plan.runId}`, "info"); return; }
					await ctx.ui.custom<void>((tui, theme, _kb, done) => new SkillEvalDashboard(plan.runId, tui, theme, done)); return;
				}
				if (["status", "monitor", "pause", "resume", "cancel", "report", "delete"].includes(command ?? "")) {
					const runId = await resolveRunId(rest[0]);
					if (command === "status") { await maybeFinalize(runId, ctx); const state = await readState(runId); pi.sendMessage({ customType: "skill-eval-status", content: statusText(state, await controllerHealth(runId)), display: true, details: state }); return; }
					if (command === "monitor") { if (!ctx.hasUI) throw new Error("/skill-eval monitor requires TUI mode"); await maybeFinalize(runId, ctx); await ctx.ui.custom<void>((tui, theme, _kb, done) => new SkillEvalDashboard(runId, tui, theme, done)); return; }
					if (command === "pause" || command === "resume") { const state = await readState(runId); if (command === "pause" && state.lifecycle !== "running" && state.lifecycle !== "preparing") throw new Error(`Cannot pause a ${state.lifecycle} run`); if (command === "resume" && state.lifecycle !== "paused" && state.lifecycle !== "pause_requested") throw new Error(`Cannot resume a ${state.lifecycle} run`); const request = await submitControl(runId, command); ctx.ui.notify(`${command} requested (${request.id.slice(0, 8)}).`, "info"); return; }
					if (command === "cancel") { const state = await readState(runId); if (["completed", "cancelled", "interrupted"].includes(state.lifecycle)) throw new Error("Run is already terminal"); const confirmed = await ctx.ui.confirm("Cancel skill evaluation?", `${runId}\nCancellation is immediate and irreversible. Active cells will be terminated.`); if (confirmed) { await submitControl(runId, "cancel"); ctx.ui.notify("Cancellation requested.", "warning"); } return; }
					if (command === "report") { const report = runPaths(runDirectory(runId)).reportMarkdown; const content = await readFile(report, "utf8").catch(() => undefined); if (!content) throw new Error("Report is not available yet"); pi.sendMessage({ customType: "skill-eval-report", content, display: true, details: { runId, path: report } }); return; }
					if (command === "delete") { const confirmed = await ctx.ui.confirm("Delete skill evaluation?", `${runId}\nThis permanently removes its audit bundle.`); if (confirmed) { await deleteRun(runId); ctx.ui.notify(`Deleted ${runId}.`, "info"); } return; }
				}
				throw new Error(`Unknown skill-eval command: ${command ?? ""}\n${usage()}`);
			} catch (error) { ctx.ui.notify(errorMessage(error), "error"); }
		},
	});
}
