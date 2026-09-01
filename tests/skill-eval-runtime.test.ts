import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChildUI, InteractionBlockedError } from "../extensions/evals/skill-eval/child-ui.ts";
import { loadSkillEvalConfig } from "../extensions/evals/skill-eval/config.ts";
import { generateReports } from "../extensions/evals/skill-eval/report.ts";
import { runEvaluation } from "../extensions/evals/skill-eval/runner.ts";
import { RunStorage, SkillEvalStorageError } from "../extensions/evals/skill-eval/storage.ts";
import { applyRemovals, applyReplacements, captureDiff, copyWorkspace, establishBaseline } from "../extensions/evals/skill-eval/workspace.ts";

const execFileAsync = promisify(execFile);
let root: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "skill-eval-runtime-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function fixture() {
	const project = path.join(root, "project");
	const evalDir = path.join(root, "eval");
	await mkdir(path.join(project, "src"), { recursive: true });
	await mkdir(evalDir);
	await writeFile(path.join(project, "src", "value.txt"), "original\n");
	await writeFile(path.join(project, "src", "obsolete.txt"), "remove me\n");
	await writeFile(path.join(evalDir, "replacement.txt"), "prepared\n");
	const yamlPath = path.join(evalDir, "eval.yaml");
	await writeFile(yamlPath, `version: 1
name: runtime-test
workspace: ../project
agent:
  harness: pi
  model: provider/model
replacements:
  - source: replacement.txt
    target: src/value.txt
removals:
  - src/obsolete.txt
  - src/missing.txt
variants:
  first:
    prompt: Change the value.
`);
	return { project, yamlPath, resolved: await loadSkillEvalConfig(yamlPath) };
}

describe("skill eval runtime", () => {
	it("auto-rejects standard dialogs and blocks generic custom UI", async () => {
		const events: string[] = [];
		const child = createChildUI({} as ExtensionUIContext, "auto-reject", {
			onRequest: (kind) => events.push(`request:${kind}`),
			onResponse: (kind) => events.push(`response:${kind}`),
			onBlocked: (kind) => events.push(`blocked:${kind}`),
			onWaitStart: () => {},
			onWaitEnd: () => {},
		});
		await expect(child.confirm("Safety", "Proceed?")).resolves.toBe(false);
		await expect(child.select("Pick", ["A"])).resolves.toBeUndefined();
		await expect(child.custom(() => ({ render: () => [], invalidate: () => {} }))).rejects.toBeInstanceOf(InteractionBlockedError);
		expect(events).toContain("blocked:custom");
	});

	it("prepares a compact, stable baseline and captures changes after copying a variant", async () => {
		const { project, resolved } = await fixture();
		const prepared = path.join(root, "prepared");
		await copyWorkspace(project, prepared);
		const replacements = await applyReplacements(resolved, prepared);
		expect(replacements[0]).toMatchObject({ target: "src/value.txt", size: 9 });
		const removals = await applyRemovals(resolved, prepared);
		expect(removals).toEqual([
			{ target: "src/obsolete.txt", existed: true },
			{ target: "src/missing.txt", existed: false },
		]);
		await expect(readFile(path.join(prepared, "src", "obsolete.txt"))).rejects.toThrow();
		const baseline = await establishBaseline(prepared);

		const maintenance = await execFileAsync("git", ["config", "--local", "--get", "maintenance.auto"], { cwd: prepared });
		expect(maintenance.stdout.trim()).toBe("false");
		const objectPacks = await readdir(path.join(prepared, ".git", "objects", "pack"));
		expect(objectPacks.some((name) => name.endsWith(".pack"))).toBe(true);

		const workspace = path.join(root, "variant");
		await copyWorkspace(prepared, workspace);
		const copiedBaseline = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace });
		expect(copiedBaseline.stdout.trim()).toBe(baseline);
		await writeFile(path.join(workspace, "src", "value.txt"), "agent change\n");
		await execFileAsync("git", ["add", "--all"], { cwd: workspace });
		await execFileAsync("git", ["commit", "--quiet", "-m", "agent commit"], { cwd: workspace });

		const diff = await captureDiff(workspace, baseline);
		expect(diff.patch).toContain("agent change");
		expect(diff.changedFiles).toBe(1);
		expect(diff.status).toBe("");
	});

	it("rejects removal of a directory", async () => {
		const { resolved } = await fixture();
		const workspace = path.join(root, "workspace");
		await copyWorkspace(resolved.workspacePath, workspace);
		const directoryRemoval = { ...resolved, removals: [{ target: "src", targetPath: path.join(workspace, "src") }] };
		await expect(applyRemovals(directoryRemoval, workspace)).rejects.toThrow("Removal target is a directory: src");
	});

	it("rejects replacement writes through a parent symlink", async () => {
		const { project, resolved } = await fixture();
		const workspace = path.join(root, "workspace");
		const outside = path.join(root, "outside");
		await mkdir(outside);
		await copyWorkspace(project, workspace);
		await rm(path.join(workspace, "src"), { recursive: true });
		await symlink(outside, path.join(workspace, "src"));
		await expect(applyReplacements(resolved, workspace)).rejects.toThrow("traverses a symlink outside");
	});

	it("retains a partial report and removes workspaces after a harness error", async () => {
		const { resolved } = await fixture();
		const runs = path.join(root, "runs");
		const agentDir = path.join(root, "agent");
		await Promise.all([mkdir(runs), mkdir(agentDir)]);
		const result = await runEvaluation(resolved, {
			baseDir: runs,
			agentDir,
			parentUI: {} as ExtensionUIContext,
			signal: new AbortController().signal,
			onEvent: () => {},
		});
		expect(result.status).toBe("harness_error");
		expect(result.storage.record.failurePhase).toBe("resolve_model");
		expect(result.storage.record.variants[0]?.status).toBe("harness_error");
		expect(result.storage.record.variants[0]?.errors?.[0]).toMatchObject({ name: "Error", message: "Configured model is unavailable: provider/model" });
		const failure = JSON.parse(await readFile(path.join(result.storage.runDir, "failure.json"), "utf8"));
		expect(failure).toMatchObject({
			summary: "Evaluation harness failed during resolve model.",
			run: { status: "harness_error", failurePhase: "resolve_model" },
			activeVariant: "first",
		});
		expect(failure.variants[0].errors[0].stack).toContain("Configured model is unavailable");
		await expect(readFile(path.join(result.storage.runDir, "report.md"), "utf8")).resolves.toContain("[failure.json](failure.json)");
		await expect(readFile(path.join(result.storage.runDir, "workspaces"), "utf8")).rejects.toThrow();
	}, 15_000);

	it("retains initialization diagnostics when canonical setup fails", async () => {
		const { resolved, yamlPath } = await fixture();
		const base = path.join(root, "runs");
		await mkdir(base);
		await rm(yamlPath);
		let failure: SkillEvalStorageError | undefined;
		try {
			await RunStorage.create(base, resolved);
		} catch (error) {
			if (error instanceof SkillEvalStorageError) failure = error;
			else throw error;
		}
		expect(failure?.message).toContain("Diagnostic directory");
		const evidence = JSON.parse(await readFile(path.join(failure!.runDir, "failure.json"), "utf8"));
		expect(evidence.run).toMatchObject({ status: "harness_error", failurePhase: "initialize_storage" });
		expect(evidence.run.errors[0].code).toBe("ENOENT");
	}, 15_000);

	it("serializes Error details in normalized lifecycle evidence", async () => {
		const { resolved } = await fixture();
		const base = path.join(root, "runs");
		await mkdir(base);
		const storage = await RunStorage.create(base, resolved);
		const error = Object.assign(new Error("extension exploded", { cause: new Error("root cause") }), {
			code: "EEXT",
			stdout: Buffer.from("diagnostic stdout"),
			stderr: "diagnostic stderr",
		});
		await storage.appendEvent({ timestamp: new Date().toISOString(), runId: storage.record.runId, kind: "extension_error", data: error });
		await storage.flush();
		const event = JSON.parse((await readFile(storage.eventsPath, "utf8")).trim());
		expect(event.data).toMatchObject({
			name: "Error",
			message: "extension exploded",
			code: "EEXT",
			stdout: "diagnostic stdout",
			stderr: "diagnostic stderr",
			cause: { message: "root cause" },
		});
		expect(event.data.stack).toContain("extension exploded");
	});

	it("retains an optional reviewer rubric without adding it to the execution config", async () => {
		const { yamlPath } = await fixture();
		await writeFile(path.join(path.dirname(yamlPath), "eval.review.yaml"), `version: 1
objective: Verify the requested value change.
variants:
  first:
    expected:
      - Change the value.
`);
		const resolved = await loadSkillEvalConfig(yamlPath);
		const base = path.join(root, "runs");
		await mkdir(base);
		const storage = await RunStorage.create(base, resolved);
		expect(storage.record.artifacts.reviewRubric).toEqual({ path: "review-rubric.yaml", completeness: "complete" });
		await expect(readFile(path.join(storage.runDir, "review-rubric.yaml"), "utf8")).resolves.toContain("Verify the requested value change");
	});

	it("generates reports using retained artifacts only", async () => {
		const { resolved } = await fixture();
		const base = path.join(root, "runs");
		await mkdir(base);
		const storage = await RunStorage.create(base, resolved);
		const variant = storage.getVariant("first");
		await storage.prepareVariantDirectory("first");
		variant.status = "completed";
		variant.metrics = {
			wallTimeMs: 1000, activeTimeMs: 900, dialogWaitMs: 100,
			inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0,
			cost: "unavailable", toolCalls: 0, toolFailures: 0,
			changedFiles: 1, insertions: 1, deletions: 1,
		};
		variant.artifacts.finalResponse.completeness = "complete";
		await writeFile(path.join(storage.variantDir("first"), "final-response.md"), "Finished the task.\n");
		storage.record.status = "completed";
		storage.record.completedAt = new Date().toISOString();
		await storage.save();
		await generateReports(storage.runDir);

		const markdown = await readFile(path.join(storage.runDir, "report.md"), "utf8");
		const html = await readFile(path.join(storage.runDir, "report.html"), "utf8");
		expect(markdown).toContain("Finished the task.");
		expect(markdown).toContain("[finalResponse](variants/first/final-response.md)");
		expect(html).toContain("Finished the task.");
	});
});
