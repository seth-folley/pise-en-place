import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { getGitUsageProjectAttribution, mergeUsageProjectAttribution, readUsageConfig, writeUsageConfig } from "../src/shared/usage-attribution.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("usage attribution", () => {
	it("preserves source Git identity while allowing local config to override either field", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "usage-attribution-"));
		roots.push(root);
		const source = path.join(root, "source");
		const target = path.join(root, "target");
		await mkdir(path.join(source, ".pi"), { recursive: true });
		await execFileAsync("git", ["init", "--quiet"], { cwd: source });
		await execFileAsync("git", ["remote", "add", "origin", "git@github.com:SethFolley/Pise-En-Place.git"], { cwd: source });
		await execFileAsync("git", ["checkout", "--quiet", "-b", "feature/eval-cost"], { cwd: source });
		await writeFile(path.join(source, ".pi", "usage.json"), JSON.stringify({ version: 1, project: { gitBranch: "release/candidate" }, tags: ["evaluation"] }));

		const config = await readUsageConfig(source);
		const attribution = mergeUsageProjectAttribution(await getGitUsageProjectAttribution(source), config?.project ?? null);
		await mkdir(target);
		await writeUsageConfig(target, { project: attribution, tags: [...(config?.tags ?? []), "skill-eval"] });

		expect(await readUsageConfig(target)).toEqual({
			project: { gitRemote: "github.com/sethfolley/pise-en-place", gitBranch: "release/candidate" },
			tags: ["evaluation", "skill-eval"],
		});
	});
});
