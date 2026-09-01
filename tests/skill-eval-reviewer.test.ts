import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const renderer = path.resolve("skills/skill-eval-reviewer/scripts/render-review.mjs");
const criteria = [
	"outcome_correctness",
	"guidance_adherence",
	"investigation",
	"change_quality",
	"verification",
	"final_response",
	"efficiency",
	"safety_policy",
	"evidence_sufficiency",
];
let root: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "skill-eval-reviewer-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function review(runPath: string) {
	return {
		version: 1,
		rubricVersion: 1,
		generatedAt: "2026-08-21T20:44:25Z",
		reviewer: { agent: "pi", model: "provider/model" },
		run: { id: "run-id", name: "<script>alert('name')</script>", operationalStatus: "completed", path: runPath },
		evidenceBoundary: "retained_artifacts",
		objective: { text: "Review observable behavior.", source: "authored" },
		overall: { outcome: "meets_expectations", confidence: "high", summary: "The agent met the authored expectations." },
		evidenceIntegrity: { status: "complete", findings: [] },
		variants: [{
			id: "first",
			executionStatus: "completed",
			outcome: "meets_expectations",
			confidence: "high",
			summary: "The final result is supported by the patch.",
			metrics: {
				wallTimeMs: 1200, activeTimeMs: 1000, dialogWaitMs: 200,
				inputTokens: 100, outputTokens: 50, cacheReadTokens: 25, cacheWriteTokens: 10,
				cost: "unavailable", toolCalls: 2, toolFailures: 0,
				changedFiles: 1, insertions: 2, deletions: 1,
			},
			expectations: [{
				type: "expected",
				text: "Make the requested change.",
				source: "authored",
				status: "met",
				finding: "The patch contains the requested change.",
				citations: [{ artifact: "variants/first/diff.patch", locator: "src/value.txt", description: "Requested line changed." }],
			}],
			criteria: criteria.map((id) => ({ id, status: "met", finding: `${id} is supported.`, citations: [] })),
			strengths: ["Scoped change."],
			concerns: [],
			recommendations: [],
		}],
		crossVariant: { patterns: [], recommendations: [] },
		limitations: [],
	};
}

describe("skill eval reviewer report", () => {
	it("validates structured review JSON, escapes content, and links retained evidence", async () => {
		const runPath = path.join(root, "run");
		const reviewDir = path.join(runPath, "reviews", "review-id");
		await mkdir(path.join(runPath, "variants", "first"), { recursive: true });
		await mkdir(reviewDir, { recursive: true });
		await writeFile(path.join(runPath, "variants", "first", "diff.patch"), "patch\n");
		const input = path.join(reviewDir, "review.json");
		const output = path.join(reviewDir, "review.html");
		const value = review(runPath);
		await writeFile(path.join(runPath, "run.json"), `${JSON.stringify({
			runId: value.run.id,
			name: value.run.name,
			status: value.run.operationalStatus,
			variants: value.variants.map((variant) => ({ id: variant.id, status: variant.executionStatus, metrics: variant.metrics })),
		})}\n`);
		await writeFile(input, `${JSON.stringify(value, null, 2)}\n`);

		await execFileAsync(process.execPath, [renderer, "--input", input, "--output", output]);
		const html = await readFile(output, "utf8");
		expect(html).toContain("&lt;script&gt;alert(&#39;name&#39;)&lt;/script&gt;");
		expect(html).not.toContain("<script>alert('name')</script>");
		expect(html).toContain('href="../../variants/first/diff.patch"');
		expect(html).toContain("outcome correctness");
	});

	it("rejects reviews missing a common criterion", async () => {
		const runPath = path.join(root, "run");
		const reviewDir = path.join(runPath, "reviews", "review-id");
		await mkdir(reviewDir, { recursive: true });
		const value = review(runPath);
		value.variants[0]!.criteria.pop();
		const input = path.join(reviewDir, "review.json");
		const output = path.join(reviewDir, "review.html");
		await writeFile(input, `${JSON.stringify(value)}\n`);

		await expect(execFileAsync(process.execPath, [renderer, "--input", input, "--output", output])).rejects.toMatchObject({
			stderr: expect.stringContaining("criteria is missing evidence_sufficiency"),
		});
	});

	it("rejects citation paths that escape the retained run", async () => {
		const runPath = path.join(root, "run");
		const reviewDir = path.join(runPath, "reviews", "review-id");
		await mkdir(reviewDir, { recursive: true });
		const value = review(runPath);
		value.variants[0]!.expectations[0]!.citations[0]!.artifact = "../outside.txt";
		const input = path.join(reviewDir, "review.json");
		const output = path.join(reviewDir, "review.html");
		await writeFile(input, `${JSON.stringify(value)}\n`);

		await expect(execFileAsync(process.execPath, [renderer, "--input", input, "--output", output])).rejects.toMatchObject({
			stderr: expect.stringContaining("must not escape the run directory"),
		});
	});
});
