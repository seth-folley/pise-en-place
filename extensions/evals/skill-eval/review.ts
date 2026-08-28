import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { expandHomePath, normalizeCommandPathInput, resolveCommandPath } from "./paths.ts";
import type { RunRecord } from "./types.ts";

export interface ReviewableRun {
	runDir: string;
	record: RunRecord;
}

export class SkillEvalReviewError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SkillEvalReviewError";
	}
}

export function skillEvalRunsDirectory(): string {
	return path.join(getAgentDir(), "skill-evals");
}

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function parseRun(runDir: string): Promise<RunRecord> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
	} catch (error) {
		throw new SkillEvalReviewError(`Cannot read retained run.json in ${runDir}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!value || typeof value !== "object") throw new SkillEvalReviewError(`Invalid retained run.json in ${runDir}`);
	const record = value as Partial<RunRecord>;
	if (record.artifactVersion !== 1 || typeof record.runId !== "string" || typeof record.name !== "string" || typeof record.status !== "string" || !Array.isArray(record.variants)) {
		throw new SkillEvalReviewError(`Unsupported or incomplete retained run.json in ${runDir}`);
	}
	return record as RunRecord;
}

async function candidateForLatest(baseDir: string): Promise<string> {
	let directories;
	try {
		directories = (await readdir(baseDir, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort((left, right) => right.localeCompare(left));
	} catch (error) {
		throw new SkillEvalReviewError(`Cannot list retained skill-eval runs in ${baseDir}: ${error instanceof Error ? error.message : String(error)}`);
	}
	for (const directory of directories) {
		try {
			if ((await stat(path.join(baseDir, directory, "run.json"))).isFile()) return path.join(baseDir, directory);
		} catch {
			// Ignore unrelated or incomplete runtime directories when selecting the newest retained run.
		}
	}
	throw new SkillEvalReviewError(`No retained skill-eval runs found in ${baseDir}`);
}

export async function resolveReviewRun(input: string, options: { baseDir?: string; cwd?: string } = {}): Promise<ReviewableRun> {
	const baseDir = path.resolve(options.baseDir ?? skillEvalRunsDirectory());
	const value = normalizeCommandPathInput(input);
	if (!value) throw new SkillEvalReviewError("A retained run ID, path, or `latest` is required");
	const candidate = value === "latest"
		? await candidateForLatest(baseDir)
		: value.includes(path.sep) || path.isAbsolute(expandHomePath(value))
			? resolveCommandPath(value, options.cwd ?? process.cwd())
			: path.join(baseDir, value);

	let canonicalBase: string;
	let runDir: string;
	try {
		[canonicalBase, runDir] = await Promise.all([realpath(baseDir), realpath(candidate)]);
		if (!(await stat(runDir)).isDirectory()) throw new Error("not a directory");
	} catch (error) {
		throw new SkillEvalReviewError(`Retained run directory does not exist: ${candidate}${error instanceof Error && error.message !== "not a directory" ? ` (${error.message})` : ""}`);
	}
	if (!isInside(canonicalBase, runDir)) throw new SkillEvalReviewError(`Retained run must be inside ${canonicalBase}`);

	const record = await parseRun(runDir);
	if (record.status === "preparing" || record.status === "running") {
		throw new SkillEvalReviewError(`Run ${record.runId} is still ${record.status}; wait for it to settle before reviewing`);
	}
	return { runDir, record };
}

export async function recentReviewRuns(baseDir = skillEvalRunsDirectory(), limit = 5): Promise<Array<{ id: string; status: string }>> {
	let directories: string[];
	try {
		directories = (await readdir(baseDir, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort((left, right) => right.localeCompare(left));
	} catch {
		return [];
	}
	const result: Array<{ id: string; status: string }> = [];
	for (const directory of directories) {
		if (result.length >= limit) break;
		try {
			const record = await parseRun(path.join(baseDir, directory));
			result.push({ id: record.runId, status: record.status });
		} catch {
			// Recent-run hints should remain available when one retained directory is malformed.
		}
	}
	return result;
}

export function reviewerSkillPrompt(runDir: string): string {
	return `/skill:skill-eval-reviewer Review the retained skill-evaluation run at ${JSON.stringify(runDir)}. Use retained artifacts only.`;
}
