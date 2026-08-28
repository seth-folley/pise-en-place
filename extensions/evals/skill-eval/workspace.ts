import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ResolvedSkillEvalConfig } from "./config.ts";

const execFileAsync = promisify(execFile);

export interface ReplacementEvidence {
	source: string;
	target: string;
	size: number;
	mode: number;
	sha256: string;
}

export interface RemovalEvidence {
	target: string;
	existed: boolean;
}

export interface DiffEvidence {
	status: string;
	patch: string;
	changedFiles: number;
	insertions: number;
	deletions: number;
}

function assertNotAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new Error("Evaluation cancelled");
}

function inside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function nearestExistingParent(target: string): Promise<string> {
	let current = path.dirname(target);
	for (;;) {
		try {
			await lstat(current);
			return current;
		} catch {
			const parent = path.dirname(current);
			if (parent === current) throw new Error(`No existing parent for replacement target: ${target}`);
			current = parent;
		}
	}
}

export async function copyWorkspace(source: string, target: string, signal?: AbortSignal): Promise<void> {
	assertNotAborted(signal);
	await cp(source, target, {
		recursive: true,
		dereference: false,
		verbatimSymlinks: true,
		preserveTimestamps: true,
		mode: constants.COPYFILE_FICLONE,
	});
	assertNotAborted(signal);
}

export async function applyReplacements(
	resolved: ResolvedSkillEvalConfig,
	workspace: string,
	signal?: AbortSignal,
): Promise<ReplacementEvidence[]> {
	const workspaceRoot = await realpath(workspace);
	const evidence: ReplacementEvidence[] = [];

	for (const replacement of resolved.replacements) {
		assertNotAborted(signal);
		const target = path.resolve(workspace, replacement.target);
		if (!inside(workspace, target)) throw new Error(`Replacement target escapes workspace: ${replacement.target}`);

		// Resolve the nearest existing parent so evaluator writes cannot traverse a copied symlink.
		const existingParent = await nearestExistingParent(target);
		const resolvedParent = await realpath(existingParent);
		if (!inside(workspaceRoot, resolvedParent)) {
			throw new Error(`Replacement target traverses a symlink outside the workspace: ${replacement.target}`);
		}

		await mkdir(path.dirname(target), { recursive: true });
		await rm(target, { recursive: true, force: true });
		const contents = await readFile(replacement.sourcePath);
		const sourceStat = await stat(replacement.sourcePath);
		await writeFile(target, contents, { mode: sourceStat.mode & 0o777 });
		await chmod(target, sourceStat.mode & 0o777);
		evidence.push({
			source: replacement.source,
			target: replacement.target,
			size: contents.byteLength,
			mode: sourceStat.mode & 0o777,
			sha256: createHash("sha256").update(contents).digest("hex"),
		});
	}
	return evidence;
}

export async function applyRemovals(
	resolved: ResolvedSkillEvalConfig,
	workspace: string,
	signal?: AbortSignal,
): Promise<RemovalEvidence[]> {
	const workspaceRoot = await realpath(workspace);
	const evidence: RemovalEvidence[] = [];

	for (const removal of resolved.removals) {
		assertNotAborted(signal);
		const target = path.resolve(workspace, removal.target);
		if (!inside(workspace, target)) throw new Error(`Removal target escapes workspace: ${removal.target}`);

		const existingParent = await nearestExistingParent(target);
		const resolvedParent = await realpath(existingParent);
		if (!inside(workspaceRoot, resolvedParent)) {
			throw new Error(`Removal target traverses a symlink outside the workspace: ${removal.target}`);
		}

		let targetStat;
		try {
			targetStat = await lstat(target);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				evidence.push({ target: removal.target, existed: false });
				continue;
			}
			throw error;
		}
		if (targetStat.isDirectory()) throw new Error(`Removal target is a directory: ${removal.target}`);
		await rm(target, { force: true });
		evidence.push({ target: removal.target, existed: true });
	}
	return evidence;
}

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		signal,
		maxBuffer: 100 * 1024 * 1024,
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
	});
	return stdout;
}

export async function establishBaseline(workspace: string, signal?: AbortSignal): Promise<string> {
	assertNotAborted(signal);
	// Only root metadata is removed; nested project content remains exactly as copied.
	await rm(path.join(workspace, ".git"), { recursive: true, force: true });
	await git(workspace, ["init", "--quiet"], signal);
	await git(workspace, ["config", "user.name", "Pi Skill Eval"], signal);
	await git(workspace, ["config", "user.email", "skill-eval@localhost"], signal);
	await git(workspace, ["config", "commit.gpgSign", "false"], signal);
	// A large baseline commit can start detached maintenance that mutates .git/objects
	// while the prepared workspace is being copied for a variant.
	await git(workspace, ["config", "maintenance.auto", "false"], signal);
	const hooksDirectory = path.join(workspace, ".git", "skill-eval-hooks");
	await mkdir(hooksDirectory);
	await git(workspace, ["config", "core.hooksPath", hooksDirectory], signal);
	await git(workspace, ["add", "--all"], signal);
	await git(workspace, ["commit", "--quiet", "--allow-empty", "-m", "skill-eval baseline"], signal);
	// Compact synchronously so variant copies see a stable, efficient object database.
	await git(workspace, ["gc", "--quiet"], signal);
	return (await git(workspace, ["rev-parse", "HEAD"], signal)).trim();
}

export async function captureDiff(workspace: string, baselineSha: string, signal?: AbortSignal): Promise<DiffEvidence> {
	const status = await git(workspace, ["status", "--short", "--untracked-files=all"], signal);
	await git(workspace, ["add", "--all"], signal);
	const patch = await git(workspace, ["diff", "--cached", "--binary", baselineSha, "--"], signal);
	const numstat = await git(workspace, ["diff", "--cached", "--numstat", baselineSha, "--"], signal);
	let changedFiles = 0;
	let insertions = 0;
	let deletions = 0;
	for (const line of numstat.trim().split("\n")) {
		if (!line) continue;
		const [added, removed] = line.split("\t");
		changedFiles += 1;
		if (added !== "-") insertions += Number(added);
		if (removed !== "-") deletions += Number(removed);
	}
	return { status, patch, changedFiles, insertions, deletions };
}
