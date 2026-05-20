/*
 * Pi skill read ledger capture extension.
 *
 * Tracks when skills are loaded/read by Pi by appending JSONL records to:
 *
 *   ~/.pi/agent/skill-reads/ledger.jsonl
 *
 * Captures two paths:
 * - `/skill:name` command expansion via the input event.
 * - Agent reads of skill files via the built-in read tool.
 *
 * Reporting is handled by `/usage skills` in extensions/usage/index.ts.
 * The ledger stores metadata only; it never stores skill file contents or prompts.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ledgerDir = path.join(os.homedir(), ".pi", "agent", "skill-reads");
const ledgerPath = path.join(ledgerDir, "ledger.jsonl");
const schemaVersion = 1;

type SkillReadTrigger = "skill-command" | "read-tool";

type ProjectInfo = {
	name: string | null;
	gitRemote: string | null;
	gitRoot: string | null;
	gitCommonDir: string | null;
};

type SkillReadRecord = {
	version: 1;
	id: string;
	timestamp: string;
	recordedAt: string;
	trigger: SkillReadTrigger;
	sessionFile: string | null;
	sessionId: string | null;
	cwd: string | null;
	project: ProjectInfo;
	skill: {
		name: string;
		path: string | null;
		scope: string | null;
		source: string | null;
	};
	toolCallId?: string;
};

type SkillCommandInfo = {
	name: string;
	source?: string;
	sourceInfo?: {
		path?: string;
		source?: string;
		scope?: string;
		baseDir?: string;
	};
};

const seenIds = new Set<string>();

function getCwd(ctx: ExtensionContext): string | null {
	return ctx.cwd ?? (ctx.sessionManager.getCwd?.() as string | undefined) ?? process.cwd();
}

function getSessionFile(ctx: ExtensionContext): string | null {
	return ctx.sessionManager.getSessionFile?.() ?? null;
}

function getSessionId(ctx: ExtensionContext): string | null {
	return ctx.sessionManager.getSessionId?.() ?? null;
}

function normalizeFilePath(filePath: string, cwd: string | null): string {
	const expanded = filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(2)) : filePath;
	return path.resolve(cwd ?? process.cwd(), expanded);
}

function getSkillCommands(pi: ExtensionAPI): SkillCommandInfo[] {
	return (pi.getCommands?.() ?? []).filter((command: SkillCommandInfo) => command.source === "skill");
}

function stripSkillCommandName(commandName: string): string {
	return commandName.startsWith("skill:") ? commandName.slice("skill:".length) : commandName;
}

function findSkillCommandByName(pi: ExtensionAPI, skillName: string): SkillCommandInfo | undefined {
	return getSkillCommands(pi).find((command) => stripSkillCommandName(command.name) === skillName);
}

function findSkillCommandByPath(pi: ExtensionAPI, filePath: string, cwd: string | null): SkillCommandInfo | undefined {
	const normalized = normalizeFilePath(filePath, cwd);
	return getSkillCommands(pi).find((command) => {
		const commandPath = command.sourceInfo?.path;
		if (!commandPath) return false;
		const normalizedCommandPath = normalizeFilePath(commandPath, cwd);
		if (normalized === normalizedCommandPath) return true;
		return path.basename(normalized) === "SKILL.md" && path.dirname(normalized) === path.dirname(normalizedCommandPath);
	});
}

function inferSkillNameFromPath(filePath: string): string {
	if (path.basename(filePath) === "SKILL.md") return path.basename(path.dirname(filePath));
	return path.basename(filePath, path.extname(filePath));
}

function isProbableSkillFile(filePath: string): boolean {
	const base = path.basename(filePath);
	if (base === "SKILL.md") return true;
	if (!base.endsWith(".md")) return false;
	const normalized = filePath.split(path.sep).join("/");
	return normalized.includes("/.pi/agent/skills/") || normalized.includes("/.agents/skills/") || normalized.includes("/.pi/skills/");
}

async function git(cwd: string, args: string[]): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("git", args, { cwd, timeout: 2_000 });
		const value = String(stdout).trim();
		return value || null;
	} catch {
		return null;
	}
}

function resolveGitPath(cwd: string, gitPath: string | null): string | null {
	if (!gitPath) return null;
	return path.isAbsolute(gitPath) ? gitPath : path.resolve(cwd, gitPath);
}

function normalizeGitRemote(remote: string | null): string | null {
	if (!remote) return null;
	let value = remote.trim();
	if (!value) return null;

	const scpLike = value.match(/^git@([^:]+):(.+)$/);
	if (scpLike) value = `${scpLike[1]}/${scpLike[2]}`;
	else value = value.replace(/^https?:\/\//, "").replace(/^ssh:\/\/git@/, "").replace(/^git@/, "");

	value = value.replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
	return value || null;
}

function deriveProjectName(project: ProjectInfo, cwd: string): string | null {
	const source = project.gitRemote ?? project.gitRoot ?? cwd;
	if (!source) return null;
	return path.basename(source.replace(/\/+$/, "")) || null;
}

async function getProjectInfo(cwd: string): Promise<ProjectInfo> {
	const gitRoot = await git(cwd, ["rev-parse", "--show-toplevel"]);
	const rawCommonDir = await git(cwd, ["rev-parse", "--git-common-dir"]);
	const remote = normalizeGitRemote(await git(cwd, ["remote", "get-url", "origin"]));
	const gitCommonDir = resolveGitPath(gitRoot ?? cwd, rawCommonDir);
	const project: ProjectInfo = { name: null, gitRemote: remote, gitRoot, gitCommonDir };
	project.name = deriveProjectName(project, cwd);
	return project;
}

async function ensureLedgerDir(): Promise<void> {
	await fs.mkdir(ledgerDir, { recursive: true });
}

async function appendLedgerRecord(record: SkillReadRecord): Promise<void> {
	await ensureLedgerDir();
	await fs.appendFile(ledgerPath, `${JSON.stringify(record)}\n`, "utf8");
}

async function buildRecord(ctx: ExtensionContext, skill: SkillCommandInfo | undefined, fallback: { name: string; path?: string | null }, trigger: SkillReadTrigger, toolCallId?: string): Promise<SkillReadRecord> {
	const timestamp = new Date().toISOString();
	const cwd = getCwd(ctx);
	const skillPath = skill?.sourceInfo?.path ?? fallback.path ?? null;
	const name = skill ? stripSkillCommandName(skill.name) : fallback.name;
	const sessionFile = getSessionFile(ctx);
	const idParts = [sessionFile ?? "ephemeral", getSessionId(ctx) ?? "unknown-session", trigger, name, toolCallId ?? timestamp];

	return {
		version: schemaVersion,
		id: idParts.join(":"),
		timestamp,
		recordedAt: timestamp,
		trigger,
		sessionFile,
		sessionId: getSessionId(ctx),
		cwd,
		project: cwd ? await getProjectInfo(cwd) : { name: null, gitRemote: null, gitRoot: null, gitCommonDir: null },
		skill: {
			name,
			path: skillPath ? normalizeFilePath(skillPath, cwd) : null,
			scope: skill?.sourceInfo?.scope ?? null,
			source: skill?.sourceInfo?.source ?? null,
		},
		...(toolCallId ? { toolCallId } : {}),
	};
}

async function recordSkillRead(record: SkillReadRecord): Promise<void> {
	if (seenIds.has(record.id)) return;
	await appendLedgerRecord(record);
	seenIds.add(record.id);
}

export default function (pi: ExtensionAPI) {
	pi.on("input", async (event, ctx) => {
		const match = event.text.match(/^\/skill:([^\s]+)\b/);
		if (!match) return;
		const skillName = match[1];
		const skill = findSkillCommandByName(pi, skillName);
		const record = await buildRecord(ctx, skill, { name: skillName, path: skill?.sourceInfo?.path ?? null }, "skill-command");
		await recordSkillRead(record);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "read") return;
		if (event.isError) return;
		const inputPath = typeof (event.input as any)?.path === "string" ? (event.input as any).path : null;
		if (!inputPath) return;
		const cwd = getCwd(ctx);
		const normalized = normalizeFilePath(inputPath, cwd);
		const skill = findSkillCommandByPath(pi, normalized, cwd);
		if (!skill && !isProbableSkillFile(normalized)) return;
		const record = await buildRecord(ctx, skill, { name: inferSkillNameFromPath(normalized), path: normalized }, "read-tool", event.toolCallId);
		await recordSkillRead(record);
	});
}
