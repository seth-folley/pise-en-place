import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

export function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

export function git(args: string[], cwd: string): string | undefined {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
	} catch {
		return undefined;
	}
}

export function normalizeRemoteUrl(remoteUrl: string): string | undefined {
	const trimmed = remoteUrl.trim();
	const scpLike = trimmed.match(/^([^@\s]+@)?([^:\s]+):(.+)$/);
	if (scpLike && !trimmed.includes("://")) {
		const host = scpLike[2].toLowerCase();
		const repoPath = scpLike[3].replace(/\.git$/i, "").replace(/^\/+/, "");
		return `${host}:${repoPath}`;
	}

	try {
		const parsed = new URL(trimmed);
		const host = parsed.hostname.toLowerCase();
		const repoPath = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/i, "");
		if (!host || !repoPath) return undefined;
		return `${host}:${repoPath}`;
	} catch {
		return undefined;
	}
}

export type ProjectInfo = {
	id?: string;
	gitRoot?: string;
	remoteUrl?: string;
	error?: string;
};

export function detectProject(cwd: string): ProjectInfo {
	const gitRoot = git(["rev-parse", "--show-toplevel"], cwd);
	if (!gitRoot) return { error: "not inside a Git worktree" };

	const remoteUrl = git(["config", "--get", "remote.origin.url"], gitRoot) ?? git(["remote", "get-url", "origin"], gitRoot);
	if (!remoteUrl) return { gitRoot, error: "Git remote origin is not configured" };

	const id = normalizeRemoteUrl(remoteUrl);
	if (!id) return { gitRoot, remoteUrl, error: "could not normalize Git remote origin URL" };

	return { id, gitRoot, remoteUrl };
}
