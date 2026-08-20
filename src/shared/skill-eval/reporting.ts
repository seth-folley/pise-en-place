import { atomicWriteJson } from "./filesystem.ts";
import { runPaths } from "./storage.ts";
import type { ResolvedPlan, RunState } from "./domain.ts";
import { writeFile } from "node:fs/promises";

function percent(value: number | undefined): string { return value === undefined || !Number.isFinite(value) ? "n/a" : `${(value * 100).toFixed(1)}%`; }
function money(value: number): string { return `$${value.toFixed(4)}`; }
function elapsed(state: RunState): string { const start = state.startedAt ? Date.parse(state.startedAt) : Date.parse(state.createdAt); const end = state.endedAt ? Date.parse(state.endedAt) : Date.now(); const seconds = Math.max(0, Math.round((end - start) / 1000)); return `${Math.floor(seconds / 60)}m ${seconds % 60}s`; }
export function reportModel(plan: ResolvedPlan, state: RunState): Record<string, unknown> {
	const cells = Object.values(state.cells); const arms = ["control", "baseline", "candidate"].map((arm) => { const selected = cells.filter((c) => c.arm === arm); return { arm, cells: selected.length, passed: selected.filter((c) => c.status === "passed").length, failed: selected.filter((c) => c.status === "failed").length, errored: selected.filter((c) => c.status === "errored").length, notRun: selected.filter((c) => ["pending", "not_run", "cancelled"].includes(c.status)).length, passRate: selected.length ? selected.filter((c) => c.status === "passed").length / selected.length : undefined, cost: selected.reduce((sum, c) => sum + (c.usage?.cost ?? 0), 0) }; });
	return { schemaVersion: 1, generatedAt: new Date().toISOString(), run: { id: state.runId, name: state.name, lifecycle: state.lifecycle, verdict: state.verdict, controllerHealth: ["completed", "cancelled", "interrupted"].includes(state.lifecycle) ? "terminal" : "unknown", evidenceComplete: state.completedCells === state.totalCells && cells.every((c) => c.status === "passed" || c.status === "failed"), isolationLevel: state.isolationLevel, profile: state.profile, elapsedMs: state.startedAt ? (state.endedAt ? Date.parse(state.endedAt) : Date.now()) - Date.parse(state.startedAt) : 0, evaluationCost: state.evaluationCost }, provenance: { baselineDigest: plan.skill.baseline.digest, candidateDigest: plan.skill.candidate.digest, skillDiff: plan.skill.diffArtifact, seed: plan.seed, runnerVersion: plan.runnerVersion, harnessVersions: plan.harnessVersions }, progress: { blocks: { completed: state.completedBlocks, total: state.totalBlocks }, cells: { completed: state.completedCells, total: state.totalCells } }, arms, acceptance: state.acceptance, warnings: state.warnings, cells };
}
export async function writeReports(runDir: string, plan: ResolvedPlan, state: RunState): Promise<void> {
	const model = reportModel(plan, state); const paths = runPaths(runDir); await atomicWriteJson(paths.reportJson, model);
	const arms = model.arms as Array<Record<string, unknown>>; const failures = Object.values(state.cells).filter((cell) => cell.status === "failed" || cell.status === "errored");
	const lines = [
		`# Skill Evaluation: ${state.name}`,
		"",
		`**Verdict:** ${state.verdict.toUpperCase()}  `,
		`**Lifecycle:** ${state.lifecycle}  `,
		`**Evidence:** ${state.completedCells}/${state.totalCells} cells, ${state.completedBlocks}/${state.totalBlocks} paired blocks  `,
		`**Isolation:** ${state.isolationLevel}  `,
		`**Elapsed:** ${elapsed(state)}  `,
		`**Observed evaluation cost:** ${money(state.evaluationCost)}`,
		"",
		"## Arm summary",
		"",
		"| Arm | Passed | Failed | Errored | Not run | Pass rate | Cost |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
		...arms.map((arm) => `| ${arm.arm} | ${arm.passed} | ${arm.failed} | ${arm.errored} | ${arm.notRun} | ${percent(arm.passRate as number | undefined)} | ${money(arm.cost as number)} |`),
		"",
		"## Acceptance",
		"",
		...(state.acceptance.length ? state.acceptance.flatMap((rule) => [`### ${rule.id}: ${rule.status}`, ...rule.buckets.map((bucket) => `- ${bucket.key}: **${bucket.status}**${bucket.observed === undefined ? "" : ` (observed ${Number.isFinite(bucket.observed) ? bucket.observed.toFixed(4) : String(bucket.observed)}, threshold ${bucket.threshold})`}${bucket.reason ? ` — ${bucket.reason}` : ""}`), ""]) : ["Exploratory run; no deterministic release gates were configured.", ""]),
		"## Failures and errors",
		"",
		...(failures.length ? failures.map((cell) => `- \`${cell.id}\` (${cell.arm}, ${cell.scenarioId}): **${cell.status}**${cell.error ? ` — ${cell.error}` : ""}`) : ["None."]),
		"",
		"## Provenance",
		"",
		`- Run ID: \`${state.runId}\``,
		`- Baseline digest: \`${plan.skill.baseline.digest}\``,
		`- Candidate digest: \`${plan.skill.candidate.digest}\``,
		`- Ordering seed: \`${plan.seed}\``,
		`- Runner / Pi: \`${plan.runnerVersion}\` / \`${plan.harnessVersions.pi}\``,
		`- Skill diff: \`${plan.skill.diffArtifact}\``,
		"",
		"## Warnings",
		"",
		...(state.warnings.length ? state.warnings.map((warning) => `- ${warning}`) : ["None."]),
		"",
		"Reports and traces are private artifacts. Persisted traces are redacted; review them before sharing.",
	];
	await writeFile(paths.reportMarkdown, `${lines.join("\n")}\n`, { mode: 0o600 });
}
