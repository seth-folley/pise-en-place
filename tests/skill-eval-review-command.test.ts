import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import skillEvalExtension from "../extensions/evals/skill-eval/index.ts";
import { recentReviewRuns, resolveReviewRun, reviewerSkillPrompt, SkillEvalReviewError } from "../extensions/evals/skill-eval/review.ts";

let root: string;
let runs: string;
let previousAgentDir: string | undefined;

beforeEach(async () => {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	root = await mkdtemp(path.join(os.tmpdir(), "skill-eval-review-command-"));
	runs = path.join(root, "runs");
	await mkdir(runs);
});

afterEach(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(root, { recursive: true, force: true });
});

async function retainedRun(id: string, status = "completed"): Promise<string> {
	const runDir = path.join(runs, id);
	await mkdir(runDir);
	await writeFile(path.join(runDir, "run.json"), `${JSON.stringify({
		artifactVersion: 1,
		runId: id,
		name: "review fixture",
		status,
		createdAt: "2026-08-21T20:44:25Z",
		configPath: "/tmp/eval.yaml",
		variants: [],
		artifacts: {},
	})}\n`);
	return runDir;
}

describe("skill eval review command helpers", () => {
	it("resolves exact run IDs and paths inside retained storage", async () => {
		const retained = await retainedRun("20260821T204425Z-example-aaaaaaaa");
		const runDir = await realpath(retained);
		await expect(resolveReviewRun(path.basename(runDir), { baseDir: runs })).resolves.toMatchObject({ runDir });
		await expect(resolveReviewRun(runDir, { baseDir: runs })).resolves.toMatchObject({ runDir });
		await expect(resolveReviewRun(`"${runDir}"`, { baseDir: runs })).resolves.toMatchObject({ runDir });
	});

	it("selects the lexically newest retained run for explicit latest", async () => {
		await retainedRun("20260821T204425Z-example-aaaaaaaa");
		const newest = await realpath(await retainedRun("20260822T204425Z-example-bbbbbbbb"));
		await expect(resolveReviewRun("latest", { baseDir: runs })).resolves.toMatchObject({ runDir: newest });
	});

	it("rejects active runs rather than reviewing changing evidence", async () => {
		await retainedRun("20260822T204425Z-example-bbbbbbbb", "running");
		await expect(resolveReviewRun("latest", { baseDir: runs })).rejects.toThrow("still running");
	});

	it("rejects paths outside retained skill-eval storage", async () => {
		const outside = path.join(root, "outside");
		await mkdir(outside);
		await writeFile(path.join(outside, "run.json"), "{}\n");
		await expect(resolveReviewRun(outside, { baseDir: runs })).rejects.toThrow("must be inside");
	});

	it("lists recent valid runs while ignoring malformed directories", async () => {
		await retainedRun("20260821T204425Z-example-aaaaaaaa", "completed");
		await retainedRun("20260822T204425Z-example-bbbbbbbb", "cancelled");
		await mkdir(path.join(runs, "diagnostics"));
		expect(await recentReviewRuns(runs)).toEqual([
			{ id: "20260822T204425Z-example-bbbbbbbb", status: "cancelled" },
			{ id: "20260821T204425Z-example-aaaaaaaa", status: "completed" },
		]);
	});

	it("builds an explicit skill invocation with a quoted canonical path", () => {
		const prompt = reviewerSkillPrompt('/tmp/run with "quotes"');
		expect(prompt).toContain("/skill:skill-eval-reviewer");
		expect(prompt).toContain('"/tmp/run with \\"quotes\\""');
		expect(prompt).toContain("Use retained artifacts only");
	});

	it("dispatches the reviewer skill through the registered subcommand", async () => {
		const agentDir = path.join(root, "agent");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		runs = path.join(agentDir, "skill-evals");
		await mkdir(runs, { recursive: true });
		const retained = await realpath(await retainedRun("20260822T204425Z-example-bbbbbbbb"));
		let handler: ((args: string, context: unknown) => Promise<void>) | undefined;
		let sent: { content: string; options?: { expandPromptTemplates?: boolean } } | undefined;
		const pi = {
			registerCommand: (_name: string, definition: { handler: typeof handler }) => { handler = definition.handler; },
			sendUserMessage: (content: string, options?: { expandPromptTemplates?: boolean }) => { sent = { content, options }; },
		} as unknown as ExtensionAPI;
		skillEvalExtension(pi);
		const notifications: string[] = [];
		await handler?.("review 20260822T204425Z-example-bbbbbbbb", {
			cwd: root,
			isIdle: () => true,
			ui: { notify: (message: string) => notifications.push(message) },
		});
		expect(sent?.content).toBe(reviewerSkillPrompt(retained));
		expect(sent?.options).toEqual({ expandPromptTemplates: true });
		expect(notifications[0]).toContain("Starting semantic review");
	});

	it("uses a dedicated error type for missing selections", async () => {
		await expect(resolveReviewRun("", { baseDir: runs })).rejects.toBeInstanceOf(SkillEvalReviewError);
	});
});
