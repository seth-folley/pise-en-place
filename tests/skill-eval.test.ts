import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../src/shared/skill-eval/filesystem.ts";
import { ValidationError } from "../src/shared/skill-eval/domain.ts";
import { loadComparison } from "../src/shared/skill-eval/planning.ts";
import { resolveComparison } from "../src/shared/skill-eval/resolver.ts";
import { runController } from "../src/shared/skill-eval/controller.ts";
import { finalizeInterrupted, initializeRun, readRegistry, readState, reserveGlobalRun, runDirectory, submitControl } from "../src/shared/skill-eval/storage.ts";
import { formatRedactedTrace } from "../extensions/evals/skill-eval/dashboard.ts";

let root: string;
let oldHome: string | undefined;
let oldPath: string | undefined;

async function fixture(extraSuite = "", acceptance = "  mode: exploratory\n"): Promise<string> {
	const repo = path.join(root, "skill-repo"); await mkdir(path.join(repo, "skill"), { recursive: true }); await writeFile(path.join(repo, "skill", "SKILL.md"), "# Baseline\n");
	for (const args of [["init", "--quiet"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test"], ["add", "."], ["commit", "--quiet", "-m", "baseline"]]) expect((await runCommand("git", args, { cwd: repo })).code).toBe(0);
	const candidate = path.join(root, "candidate"); await mkdir(candidate); await writeFile(path.join(candidate, "SKILL.md"), "# Candidate\n");
	const fixtureDir = path.join(root, "fixture"); await mkdir(fixtureDir); await writeFile(path.join(fixtureDir, "README.md"), "fixture\n"); await writeFile(path.join(fixtureDir, ".gitmodules"), "");
	const suite = path.join(root, "suite.yaml"); await writeFile(suite, `schemaVersion: 1
kind: skill-eval-suite
name: test-suite
skill:
  name: test-skill
  source:
    type: git
    repository: ${JSON.stringify(repo)}
  path: skill
defaults:
  tools: [read, write]
  permissions: { mode: workspace-write, network: false }
  limits: { scenarioTimeout: 30s, setupTimeout: 30s, checkTimeout: 30s }
profiles:
  smoke:
    repetitions: 1
    maxConcurrency: 2
    targets:
      - { harness: pi, model: test/fake, thinking: off }
scenarios:
  - id: writes-result
    title: Writes result
    covers: [core]
    purpose: Verify the complete controller flow.
    prompt: Write result.txt.
    fixture: { type: local, path: fixture }
    invocation: implicit
    runOn: [control, baseline, candidate]
    checks:
      - id: result-exists
        type: file-exists
        severity: critical
        path: result.txt
        expect: { exists: true }
${extraSuite}`);
	const comparison = path.join(root, "comparison.yaml"); await writeFile(comparison, `schemaVersion: 1
kind: skill-eval-comparison
name: test-comparison
suite: suite.yaml
arms:
  control: { skill: disabled }
  baseline: { ref: HEAD }
  candidate:
    snapshot: { path: candidate }
change: { summary: Test candidate. }
hypotheses:
  - id: writes
    expectedChange: Writes the expected file.
    mustNotRegress: [File remains valid.]
    scenarios: [writes-result]
nonGoals: []
execution:
  profile: smoke
  scenarios: { all: true }
acceptance:
${acceptance}`); return comparison;
}

beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "skill-eval-test-")); oldHome = process.env.PI_SKILL_EVAL_HOME; oldPath = process.env.PATH; process.env.PI_SKILL_EVAL_HOME = path.join(root, "runtime"); });
afterEach(async () => { if (oldHome === undefined) delete process.env.PI_SKILL_EVAL_HOME; else process.env.PI_SKILL_EVAL_HOME = oldHome; if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; await rm(root, { recursive: true, force: true }); });

describe("live redacted agent traces", () => {
	it("assembles assistant deltas, tool arguments, outcomes, and cumulative usage", () => {
		const trace = [
			{ type: "message_update", usage: { input: 10, output: 2, cost: 0.01 }, assistantMessageEvent: { type: "text_delta", delta: "I will inspect " } },
			{ type: "message_update", usage: { input: 10, output: 4, cost: 0.02 }, assistantMessageEvent: { type: "text_delta", delta: "the fixture." } },
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "I will inspect the fixture." }], usage: { input: 10, output: 4, cost: 0.02 } } },
			{ type: "tool_execution_start", toolName: "read", args: { path: "[REDACTED_PATH]/README.md" } },
			{ type: "tool_execution_end", toolName: "read", isError: false },
			{ type: "message_update", usage: { input: 7, output: 3, cost: 0.01 }, assistantMessageEvent: { type: "text_delta", delta: "Done." } },
		].map((event) => JSON.stringify(event)).join("\n") + "\n";
		const view = formatRedactedTrace(trace); expect(view.lines).toEqual(["assistant · I will inspect the fixture.", "tool → read · {\"path\":\"[REDACTED_PATH]/README.md\"}", "tool ✓ read", "assistant · Done."]); expect(view.latest).toBe("assistant · Done."); expect(view.usage?.inputTokens).toBe(17); expect(view.usage?.outputTokens).toBe(7); expect(view.usage?.cost).toBeCloseTo(0.03);
	});
});

describe("authored plan validation and resolution", () => {
	it("freezes inputs and keeps prompt bodies out of the resolved plan", async () => { const comparison = await fixture(); const plan = await resolveComparison(comparison, { skipModelValidation: true }); expect(plan.blocks).toHaveLength(1); expect(plan.blocks[0]!.cells.map((cell) => cell.arm).sort()).toEqual(["baseline", "candidate", "control"]); expect(plan.skill.baseline.git?.head).toMatch(/^[a-f0-9]{40}$/); expect(plan.skill.candidate.git?.dirty).toBeUndefined(); const serialized = JSON.stringify(plan); expect(serialized).not.toContain("Write result.txt."); expect(await readFile(path.join(runDirectory(plan.runId), plan.scenarios[0]!.promptArtifact), "utf8")).toBe("Write result.txt."); }, 30_000);
	it("fails closed on unknown fields", async () => { const comparison = await fixture("    unexpected: true\n"); await expect(loadComparison(comparison)).rejects.toBeInstanceOf(ValidationError); });
	it("runs setup before strictly validating an internal dangling symlink", async () => { const comparison = await fixture(); const fixtureDir = path.join(root, "fixture"); await symlink("generated.txt", path.join(fixtureDir, "linked.txt")); const suite = path.join(root, "suite.yaml"), source = await readFile(suite, "utf8"); await writeFile(suite, source.replace("fixture: { type: local, path: fixture }", "fixture:\n      type: local\n      path: fixture\n      setup: { command: 'rm linked.txt && printf ready > generated.txt && ln -s generated.txt linked.txt', network: false }")); const plan = await resolveComparison(comparison, { skipModelValidation: true }); const manifest = await readFile(path.join(runDirectory(plan.runId), plan.scenarios[0]!.fixtureManifestArtifact), "utf8"); expect(manifest).toContain('"path": "generated.txt"'); expect(manifest).toContain('"path": "linked.txt"'); });
	it("retains and reports redacted preparation diagnostics when setup fails", async () => { const comparison = await fixture(); const suite = path.join(root, "suite.yaml"), source = await readFile(suite, "utf8"); await writeFile(suite, source.replace("fixture: { type: local, path: fixture }", "fixture:\n      type: local\n      path: fixture\n      setup: { command: 'echo broken >&2; exit 7', network: false }")); const error = await resolveComparison(comparison, { skipModelValidation: true }).catch((value: unknown) => value); expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain("Fixture preparation diagnostics:"); const diagnostics = path.join(root, "runtime", "diagnostics"), bundles = await readdir(diagnostics); const files = await readdir(path.join(diagnostics, bundles[0]!)); expect(files).toContain("failure.json"); expect(files.some((file) => file.startsWith("preparation-"))).toBe(true); expect(files.some((file) => file.startsWith("setup-"))).toBe(true); });
});

describe("durable controller", () => {
	it("runs all three arms through a fake Pi process and writes reports", async () => {
		const comparison = await fixture("", `  mode: gated
  rules:
    - { id: complete, type: required-cell-completeness }
    - { id: candidate, type: all-candidate-critical-checks-pass }
`);
		const bin = path.join(root, "bin"); await mkdir(bin); const fakePi = path.join(bin, "pi"); await writeFile(fakePi, `#!/bin/sh
printf 'ok\\n' > result.txt
printf '%s\\n' '{"type":"tool_execution_start","toolName":"write","args":{"path":"result.txt"}}'
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","usage":{"input":10,"output":5,"cost":0.01}}}'
`); await chmod(fakePi, 0o755); process.env.PATH = `${bin}:${oldPath}`;
		const plan = await resolveComparison(comparison, { skipModelValidation: true }); await initializeRun(plan); await reserveGlobalRun(plan); await runController(plan.runId); const state = await readState(plan.runId);
		expect(state.lifecycle).toBe("completed"); expect(state.verdict).toBe("pass"); expect(Object.values(state.cells).map((cell) => cell.status)).toEqual(["passed", "passed", "passed"]); expect(state.evaluationCost).toBeCloseTo(0.03); expect(await readFile(path.join(runDirectory(plan.runId), "report.md"), "utf8")).toContain("**Verdict:** PASS"); const events = (await readFile(path.join(runDirectory(plan.runId), "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { sequence: number }); expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index + 1));
	}, 30_000);

	it("pauses at a cell checkpoint and resumes the remaining paired block", async () => {
		const comparison = await fixture(); const bin = path.join(root, "bin"); await mkdir(bin); const fakePi = path.join(bin, "pi"); await writeFile(fakePi, `#!/bin/sh
printf '%s\\n' '{"type":"message_update","usage":{"input":4,"output":1,"cost":0.002},"assistantMessageEvent":{"type":"text_delta","delta":"Working on the fixture…"}}'
sleep 0.6
printf 'ok\\n' > result.txt
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","usage":{"cost":0.01}}}'
`); await chmod(fakePi, 0o755); process.env.PATH = `${bin}:${oldPath}`;
		const plan = await resolveComparison(comparison, { skipModelValidation: true }); await initializeRun(plan); await reserveGlobalRun(plan); const running = runController(plan.runId);
		for (let index = 0; index < 100; index++) { const state = await readState(plan.runId); if (Object.values(state.cells).some((cell) => cell.status === "running")) break; await new Promise((resolve) => setTimeout(resolve, 20)); }
		const activeId = Object.values((await readState(plan.runId)).cells).find((cell) => cell.status === "running")!.id; let live = ""; for (let index = 0; index < 50; index++) { live = await readFile(path.join(runDirectory(plan.runId), "artifacts", "cells", activeId, "trace.redacted.jsonl"), "utf8").catch(() => ""); if (live.includes("Working on the fixture")) break; await new Promise((resolve) => setTimeout(resolve, 10)); } expect(formatRedactedTrace(live).latest).toContain("Working on the fixture");
		await submitControl(plan.runId, "pause"); let paused = false; for (let index = 0; index < 150; index++) { const state = await readState(plan.runId); if (state.lifecycle === "paused") { paused = true; expect(state.completedCells).toBe(2); break; } await new Promise((resolve) => setTimeout(resolve, 20)); } expect(paused).toBe(true); await submitControl(plan.runId, "resume"); await running; expect((await readState(plan.runId)).lifecycle).toBe("completed");
	}, 30_000);

	it("finalizes a missing controller as interrupted and releases the global slot", async () => {
		const plan = await resolveComparison(await fixture(), { skipModelValidation: true }); await initializeRun(plan); await reserveGlobalRun(plan); const state = await finalizeInterrupted(plan.runId, "controller missing"); expect(state.lifecycle).toBe("interrupted"); expect(state.verdict).toBe("incomplete"); expect(Object.values(state.cells).every((cell) => cell.status === "not_run")).toBe(true); expect((await readRegistry()).activeRunId).toBeUndefined();
	}, 30_000);

	it("cancels active cells without retrying or losing the audit report", async () => {
		const comparison = await fixture(); const bin = path.join(root, "bin"); await mkdir(bin); const fakePi = path.join(bin, "pi"); await writeFile(fakePi, `#!/bin/sh
sleep 20
`); await chmod(fakePi, 0o755); process.env.PATH = `${bin}:${oldPath}`;
		const plan = await resolveComparison(comparison, { skipModelValidation: true }); await initializeRun(plan); await reserveGlobalRun(plan); const running = runController(plan.runId);
		for (let index = 0; index < 100; index++) { const state = await readState(plan.runId); if (Object.values(state.cells).some((cell) => cell.status === "running")) break; await new Promise((resolve) => setTimeout(resolve, 25)); }
		await submitControl(plan.runId, "cancel"); await running; const state = await readState(plan.runId); expect(state.lifecycle).toBe("cancelled"); expect(state.verdict).toBe("incomplete"); expect(Object.values(state.cells).every((cell) => cell.status === "cancelled")).toBe(true); expect(await readFile(path.join(runDirectory(plan.runId), "report.json"), "utf8")).toContain('"lifecycle": "cancelled"');
	}, 30_000);
});
