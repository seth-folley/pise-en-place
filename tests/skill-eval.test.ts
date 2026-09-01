import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkillEvalConfig, SkillEvalConfigError } from "../extensions/evals/skill-eval/config.ts";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "skill-eval-"));
	await mkdir(path.join(root, "project"));
	await mkdir(path.join(root, "eval", "setup"), { recursive: true });
	await writeFile(path.join(root, "eval", "setup", "replacement.txt"), "replacement\n");
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function yaml(overrides = ""): string {
	return `version: 1
name: example
workspace: ../project
agent:
  harness: pi
  model: provider/model
  thinking: medium
  tools: [read, bash, edit, write]
replacements:
  - source: setup/replacement.txt
    target: generated/new-file.txt
removals:
  - obsolete.txt
variants:
  first:
    prompt: |
      Complete the first task.
${overrides}`;
}

async function writeConfig(contents = yaml()): Promise<string> {
	const file = path.join(root, "eval", "eval.yaml");
	await writeFile(file, contents);
	return file;
}

describe("skill eval config", () => {
	it("parses the schema and resolves source paths relative to the YAML", async () => {
		const config = await loadSkillEvalConfig(await writeConfig());
		expect(config.workspacePath).toBe(path.join(root, "project"));
		expect(config.replacements[0]?.sourcePath).toBe(path.join(root, "eval", "setup", "replacement.txt"));
		expect(config.replacements[0]?.targetPath).toBe(path.join(root, "project", "generated", "new-file.txt"));
		expect(config.removals[0]?.targetPath).toBe(path.join(root, "project", "obsolete.txt"));
		expect(config.config.limits).toEqual({ timeoutSeconds: 300, onTimeout: "stop", maxRetries: 0 });
		expect(config.config.dialogs).toBe("interactive");
	});

	it("discovers and validates an optional same-basename review rubric", async () => {
		const file = await writeConfig();
		await writeFile(path.join(root, "eval", "eval.review.yaml"), `version: 1
objective: Verify the expected behavior.
sharedExpectations:
  - Avoid unrelated changes.
variants:
  first:
    expected:
      - Complete the requested task.
    prohibited:
      - Modify unrelated files.
    evidenceHints:
      - Git patch
`);
		const config = await loadSkillEvalConfig(file);
		expect(config.reviewRubric?.rubricPath).toBe(path.join(root, "eval", "eval.review.yaml"));
		expect(config.reviewRubric?.rubric.objective).toBe("Verify the expected behavior.");
	});

	it("keeps review rubrics optional", async () => {
		const config = await loadSkillEvalConfig(await writeConfig());
		expect(config.reviewRubric).toBeUndefined();
	});

	it("rejects review rubric entries for unknown variants", async () => {
		const file = await writeConfig();
		await writeFile(path.join(root, "eval", "eval.review.yaml"), `version: 1
objective: Verify behavior.
variants:
  missing:
    expected: [Complete the task.]
`);
		await expect(loadSkillEvalConfig(file)).rejects.toThrow("review rubric references unknown variant: missing");
	});

	it("rejects unknown review rubric fields", async () => {
		const file = await writeConfig();
		await writeFile(path.join(root, "eval", "eval.review.yaml"), `version: 1
objective: Verify behavior.
unexpected: true
`);
		await expect(loadSkillEvalConfig(file)).rejects.toThrow("review rubric");
	});

	it("accepts explicit execution, timeout, and dialog policies", async () => {
		const file = await writeConfig(yaml().replace("variants:", "limits:\n  timeoutSeconds: 45\n  onTimeout: retry\n  maxRetries: 2\ndialogs: auto-reject\nvariants:"));
		const config = await loadSkillEvalConfig(file);
		expect(config.config.limits).toEqual({ timeoutSeconds: 45, onTimeout: "retry", maxRetries: 2 });
		expect(config.config.dialogs).toBe("auto-reject");
	});

	it("defaults retry count to one when retry behavior is selected", async () => {
		const file = await writeConfig(yaml().replace("variants:", "limits:\n  onTimeout: retry\nvariants:"));
		const config = await loadSkillEvalConfig(file);
		expect(config.config.limits.maxRetries).toBe(1);
	});

	it("requires retry behavior when max retries is configured", async () => {
		const file = await writeConfig(yaml().replace("variants:", "limits:\n  maxRetries: 2\nvariants:"));
		await expect(loadSkillEvalConfig(file)).rejects.toThrow("limits.maxRetries requires limits.onTimeout: retry");
	});

	it("allows a replacement target and parent directory that do not exist", async () => {
		await expect(loadSkillEvalConfig(await writeConfig())).resolves.toBeDefined();
	});

	it("rejects missing replacement source files", async () => {
		const file = await writeConfig(yaml().replace("setup/replacement.txt", "setup/missing.txt"));
		await expect(loadSkillEvalConfig(file)).rejects.toThrow("Replacement source file does not exist");
	});

	it("rejects malformed YAML", async () => {
		const file = await writeConfig("version: [\n");
		await expect(loadSkillEvalConfig(file)).rejects.toBeInstanceOf(SkillEvalConfigError);
	});

	it("rejects unknown schema fields", async () => {
		const file = await writeConfig(`${yaml()}unexpected: true\n`);
		await expect(loadSkillEvalConfig(file)).rejects.toThrow("must not have additional properties");
	});

	it("rejects invalid execution policies", async () => {
		const file = await writeConfig(yaml().replace("variants:", "limits:\n  timeoutSeconds: 0\ndialogs: accept\nvariants:"));
		await expect(loadSkillEvalConfig(file)).rejects.toBeInstanceOf(SkillEvalConfigError);
	});

	it("rejects variant names that cannot safely name artifact directories", async () => {
		const file = await writeConfig(yaml().replace("  first:", "  ../first:"));
		await expect(loadSkillEvalConfig(file)).rejects.toThrow("filesystem-safe identifier");
	});

	it("rejects targets that escape the workspace", async () => {
		const file = await writeConfig(yaml().replace("generated/new-file.txt", "../outside.txt"));
		await expect(loadSkillEvalConfig(file)).rejects.toThrow("target escapes the workspace");
	});

	it("rejects removal targets that escape the workspace", async () => {
		const file = await writeConfig(yaml().replace("  - obsolete.txt", "  - ../outside.txt"));
		await expect(loadSkillEvalConfig(file)).rejects.toThrow("removals[0] escapes the workspace");
	});
});
