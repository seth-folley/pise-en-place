import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const usageConfigRelativePath = path.join(".pi", "usage.json");

export type UsageProjectAttribution = {
	gitRemote?: string;
	gitBranch?: string;
};

export type UsageConfig = {
	project: UsageProjectAttribution | null;
	tags: string[];
};

function optionalNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeUsageTags(tags: string[]): string[] {
	return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

/** Normalize Git remotes to the same stable project key used by the usage ledger. */
export function normalizeGitRemote(remote: string | null | undefined): string | null {
	if (!remote) return null;
	let value = remote.trim();
	if (!value) return null;

	const scpLike = value.match(/^git@([^:]+):(.+)$/);
	if (scpLike) value = `${scpLike[1]}/${scpLike[2]}`;
	else value = value.replace(/^https?:\/\//, "").replace(/^ssh:\/\/git@/, "").replace(/^git@/, "");

	value = value.replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
	return value || null;
}

/** Reads optional local project attribution and default tags. Invalid config is rejected so callers can retain fallbacks. */
export async function readUsageConfig(cwd: string): Promise<UsageConfig | null> {
	const configPath = path.join(cwd, usageConfigRelativePath);
	let config: unknown;
	try {
		config = JSON.parse(await readFile(configPath, "utf8"));
	} catch (error: any) {
		if (error?.code === "ENOENT") return null;
		throw new Error(`Invalid usage config at ${configPath}: ${error?.message ?? String(error)}`);
	}
	if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`Invalid usage config at ${configPath}: expected a JSON object`);
	const { version, project, tags } = config as { version?: unknown; project?: unknown; tags?: unknown };
	if (version !== 1) throw new Error(`Invalid usage config at ${configPath}: expected version 1`);
	if (project !== undefined && (!project || typeof project !== "object" || Array.isArray(project))) {
		throw new Error(`Invalid usage config at ${configPath}: expected project to be an object`);
	}
	if (tags !== undefined && (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string" && tag.trim()))) {
		throw new Error(`Invalid usage config at ${configPath}: expected tags to be an array of non-empty strings`);
	}
	const values = (project ?? {}) as Record<string, unknown>;
	const attribution = { gitRemote: optionalNonEmptyString(values.gitRemote), gitBranch: optionalNonEmptyString(values.gitBranch) };
	return {
		project: attribution.gitRemote || attribution.gitBranch ? attribution : null,
		tags: normalizeUsageTags((tags as string[] | undefined) ?? []),
	};
}

/** Writes a complete config into a disposable workspace. */
export async function writeUsageConfig(cwd: string, config: UsageConfig): Promise<void> {
	const project: UsageProjectAttribution = {};
	if (config.project?.gitRemote) project.gitRemote = config.project.gitRemote;
	if (config.project?.gitBranch) project.gitBranch = config.project.gitBranch;
	const tags = normalizeUsageTags(config.tags);
	if (!project.gitRemote && !project.gitBranch && !tags.length) return;
	const configPath = path.join(cwd, usageConfigRelativePath);
	await mkdir(path.dirname(configPath), { recursive: true });
	await writeFile(configPath, `${JSON.stringify({ version: 1, ...(project.gitRemote || project.gitBranch ? { project } : {}), ...(tags.length ? { tags } : {}) }, null, 2)}\n`, { mode: 0o600 });
}

/** Captures the source Git identity before an evaluator replaces its Git metadata. */
export async function getGitUsageProjectAttribution(cwd: string): Promise<UsageProjectAttribution> {
	const git = async (args: string[]): Promise<string | undefined> => {
		try {
			const { stdout } = await execFileAsync("git", args, { cwd, timeout: 2_000 });
			return optionalNonEmptyString(String(stdout));
		} catch {
			return undefined;
		}
	};
	return {
		gitRemote: normalizeGitRemote(await git(["remote", "get-url", "origin"])) ?? undefined,
		gitBranch: await git(["branch", "--show-current"]),
	};
}

export function mergeUsageProjectAttribution(base: UsageProjectAttribution, override: UsageProjectAttribution | null): UsageProjectAttribution {
	return {
		gitRemote: override?.gitRemote ?? base.gitRemote,
		gitBranch: override?.gitBranch ?? base.gitBranch,
	};
}
