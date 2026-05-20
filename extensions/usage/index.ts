/*
 * Pi usage ledger extension.
 *
 * Tracks token usage and estimated spending across Pi sessions by appending one
 * JSONL record per finalized assistant response to:
 *
 *   ~/.pi/agent/usage/ledger.jsonl
 *
 * Design goals:
 * - Track only usage metadata, never prompt/response content.
 * - Start tracking when the extension is enabled; do not rescan old sessions.
 * - Keep storage simple with append-only JSONL.
 * - Derive summaries from raw records on demand.
 * - Group projects by git metadata so worktrees roll up together where possible.
 *
 * See docs/usage-tracking.md and docs/usage-tracking-design.md.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ledgerDir = path.join(os.homedir(), ".pi", "agent", "usage");
const ledgerPath = path.join(ledgerDir, "ledger.jsonl");
const skillReadLedgerPath = path.join(os.homedir(), ".pi", "agent", "skill-reads", "ledger.jsonl");
const schemaVersion = 1;

type UsageRange = "today" | "week" | "month" | "lifetime";
type UsageMode = "summary" | "project" | "model" | "skills" | "clear";

type ProjectInfo = {
	name: string | null;
	gitRemote: string | null;
	gitRoot: string | null;
	gitCommonDir: string | null;
};

type UsageLedgerRecord = {
	version: 1;
	id: string;
	source: "live";
	timestamp: string;
	recordedAt: string;
	sessionFile: string | null;
	sessionEntryId: string | null;
	cwd: string | null;
	project: ProjectInfo;
	provider: string | null;
	model: string | null;
	api: string | null;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		totalCost: number | null;
	};
};

type LedgerReadResult = {
	records: UsageLedgerRecord[];
	skippedLines: number;
};

type ParsedUsageCommand = {
	mode: UsageMode;
	range: UsageRange;
	json: boolean;
	list: boolean;
	help: boolean;
	yes: boolean;
	project?: string;
	groupByProject?: boolean;
	model?: string;
	error?: string;
};

type UsageSummary = {
	range: UsageRange;
	filter?: { project?: string; model?: string };
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	totalCost: number;
	costedCalls: number;
	tokenOnlyCalls: number;
	projects: number;
	models: number;
	skippedLines: number;
};

type SessionEntry = {
	type: string;
	id?: string;
	message?: any;
};

type SkillReadRecord = {
	version: 1;
	id: string;
	timestamp: string;
	recordedAt: string;
	trigger: "skill-command" | "read-tool";
	sessionFile: string | null;
	sessionId: string | null;
	cwd: string | null;
	project?: ProjectInfo;
	skill: {
		name: string;
		path: string | null;
		scope: string | null;
		source: string | null;
	};
	toolCallId?: string;
};

type SkillReadLedgerReadResult = {
	records: SkillReadRecord[];
	skippedLines: number;
};

// Pi command handlers receive the full argument tail as a single string. This
// tokenizer gives us shell-ish quoting so project/model names can contain spaces.
const seenRecordIds = new Set<string>();

function tokenizeArgs(args: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let escaping = false;

	for (const char of args) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}

		if (char === "\\" && quote !== "'") {
			escaping = true;
			continue;
		}

		if ((char === '"' || char === "'") && !quote) {
			quote = char;
			continue;
		}

		if (quote === char) {
			quote = null;
			continue;
		}

		if (!quote && /\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (current) tokens.push(current);
	return tokens;
}

// Parse the intentionally small command grammar into one normalized shape so
// execution can be shared across text and JSON output modes.
function parseUsageArgs(args: string): ParsedUsageCommand {
	const tokens = tokenizeArgs(args);
	const command: ParsedUsageCommand = { mode: "summary", range: "month", json: false, list: false, help: false, yes: false };
	const positionals: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];

		if (token === "--json") {
			command.json = true;
			continue;
		}

		if (token === "-h" || token === "--help") {
			command.help = true;
			continue;
		}

		if (token === "--list") {
			command.list = true;
			continue;
		}

		if (token === "--yes" || token === "-y") {
			command.yes = true;
			continue;
		}

		if (token === "--project") {
			const value = tokens[i + 1];
			if (!value || value.startsWith("--")) {
				command.groupByProject = true;
			} else {
				command.project = value;
				i += 1;
			}
			continue;
		}

		if (token === "--model") {
			const value = tokens[++i];
			if (!value) return { ...command, error: "Missing value for --model" };
			command.model = value;
			continue;
		}

		if (token.startsWith("--")) return { ...command, error: `Unknown option: ${token}` };
		positionals.push(token);
	}

	const first = positionals[0];
	if (!first) {
		if (command.groupByProject) return { ...command, error: "Missing value for --project" };
		return command;
	}

	if (first === "project") {
		command.mode = "project";
		command.range = "lifetime";
		if (positionals.length > 1) command.project = positionals.slice(1).join(" ");
		if (command.groupByProject) return { ...command, error: "Missing value for --project" };
		if (!command.list && !command.project) return { ...command, error: "Usage: /usage project --list or /usage project <project>" };
		return command;
	}

	if (first === "model") {
		command.mode = "model";
		command.range = "lifetime";
		if (positionals.length > 1) command.model = positionals.slice(1).join(" ");
		if (command.groupByProject) return { ...command, error: "Missing value for --project" };
		if (!command.list && !command.model) return { ...command, error: "Usage: /usage model --list or /usage model <model>" };
		return command;
	}

	if (first === "skills") {
		command.mode = "skills";
		if (positionals.length > 1) {
			const range = positionals[1];
			if (!["today", "week", "month", "lifetime"].includes(range)) return { ...command, error: `Unknown skills range: ${range}` };
			command.range = range as UsageRange;
		}
		if (positionals.length > 2) return { ...command, error: `Unexpected argument: ${positionals[2]}` };
		return command;
	}

	if (first === "clear") {
		command.mode = "clear";
		if (positionals.length > 1) return { ...command, error: `Unexpected argument: ${positionals[1]}` };
		return command;
	}

	if (["today", "week", "month", "lifetime"].includes(first)) {
		command.range = first as UsageRange;
		if (command.groupByProject) return { ...command, error: "Missing value for --project" };
		if (positionals.length > 1) return { ...command, error: `Unexpected argument: ${positionals[1]}` };
		return command;
	}

	if (command.groupByProject) return { ...command, error: "Missing value for --project" };
	return { ...command, error: `Unknown usage command: ${first}` };
}

// Time ranges are local-time based because these reports are meant for human
// day/week/month accounting, not UTC billing reconciliation.
function getRangeBounds(range: UsageRange, now = new Date()): { start: Date | null; end: Date | null } {
	if (range === "lifetime") return { start: null, end: null };

	const start = new Date(now);
	start.setHours(0, 0, 0, 0);

	if (range === "week") {
		const day = start.getDay();
		const daysSinceMonday = day === 0 ? 6 : day - 1;
		start.setDate(start.getDate() - daysSinceMonday);
	} else if (range === "month") {
		start.setDate(1);
	}

	return { start, end: now };
}

function inRange(record: UsageLedgerRecord, range: UsageRange): boolean {
	const { start, end } = getRangeBounds(range);
	if (!start && !end) return true;

	const timestamp = new Date(record.timestamp).getTime();
	if (!Number.isFinite(timestamp)) return false;
	if (start && timestamp < start.getTime()) return false;
	if (end && timestamp > end.getTime()) return false;
	return true;
}

// Reports group projects by the most stable git identity available. This keeps
// separate worktrees for the same remote from showing up as separate projects.
function getProjectKey(record: UsageLedgerRecord): string {
	return record.project.gitRemote ?? record.project.gitCommonDir ?? record.project.gitRoot ?? record.cwd ?? "unknown";
}

function getProjectLabels(record: UsageLedgerRecord): string[] {
	return [getProjectKey(record), record.project.name, record.project.gitRemote, record.project.gitRoot, record.project.gitCommonDir, record.cwd].filter(
		(value): value is string => Boolean(value),
	);
}

function matchesProject(record: UsageLedgerRecord, project: string): boolean {
	return getProjectLabels(record).includes(project);
}

function getSkillReadProjectKey(record: SkillReadRecord): string {
	return record.project?.gitRemote ?? record.project?.gitCommonDir ?? record.project?.gitRoot ?? record.cwd ?? "unknown";
}

function getSkillReadProjectLabels(record: SkillReadRecord): string[] {
	return [
		getSkillReadProjectKey(record),
		record.project?.name,
		record.project?.gitRemote,
		record.project?.gitRoot,
		record.project?.gitCommonDir,
		record.cwd,
	].filter((value): value is string => Boolean(value));
}

function matchesSkillReadProject(record: SkillReadRecord, project: string): boolean {
	return getSkillReadProjectLabels(record).includes(project);
}

// Include provider in the display key so identically named models from different
// providers do not collapse together.
function getModelKey(record: UsageLedgerRecord): string {
	if (record.provider && record.model) return `${record.provider}/${record.model}`;
	return record.model ?? record.provider ?? "unknown";
}

function getModelLabels(record: UsageLedgerRecord): string[] {
	return [getModelKey(record), record.model, record.provider].filter((value): value is string => Boolean(value));
}

function matchesModel(record: UsageLedgerRecord, model: string): boolean {
	return getModelLabels(record).includes(model);
}

// Summaries are derived from raw records on demand. Token-only records count
// toward tokens/calls but intentionally do not add to totalCost.
function summarizeRecords(
	records: UsageLedgerRecord[],
	options: { range: UsageRange; project?: string; model?: string; skippedLines?: number },
): UsageSummary {
	const filtered = records.filter((record) => {
		if (!inRange(record, options.range)) return false;
		if (options.project && !matchesProject(record, options.project)) return false;
		if (options.model && !matchesModel(record, options.model)) return false;
		return true;
	});

	const summary: UsageSummary = {
		range: options.range,
		filter: { project: options.project, model: options.model },
		calls: filtered.length,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		totalCost: 0,
		costedCalls: 0,
		tokenOnlyCalls: 0,
		projects: new Set(filtered.map(getProjectKey)).size,
		models: new Set(filtered.map(getModelKey)).size,
		skippedLines: options.skippedLines ?? 0,
	};

	for (const record of filtered) {
		summary.input += record.usage.input;
		summary.output += record.usage.output;
		summary.cacheRead += record.usage.cacheRead;
		summary.cacheWrite += record.usage.cacheWrite;
		summary.totalTokens += record.usage.totalTokens;

		if (typeof record.usage.totalCost === "number") {
			summary.totalCost += record.usage.totalCost;
			summary.costedCalls += 1;
		} else {
			summary.tokenOnlyCalls += 1;
		}
	}

	return summary;
}

function listProjects(records: UsageLedgerRecord[]): string[] {
	return Array.from(new Set(records.map(getProjectKey))).sort((a, b) => a.localeCompare(b));
}

function listModels(records: UsageLedgerRecord[]): string[] {
	return Array.from(new Set(records.map(getModelKey))).sort((a, b) => a.localeCompare(b));
}

function formatTokens(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 1_000_000) return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`;
	return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`;
}

function formatCost(cost: number): string {
	return `$${cost.toFixed(cost < 1 ? 4 : 2)}`;
}

function titleForRange(range: UsageRange): string {
	if (range === "today") return "Today";
	if (range === "week") return "This week";
	if (range === "month") return "This month";
	return "Lifetime";
}

function formatSummary(summary: UsageSummary): string {
	const titleParts = [`Usage — ${titleForRange(summary.range)}`];
	if (summary.filter?.project) titleParts.push(`project: ${summary.filter.project}`);
	if (summary.filter?.model) titleParts.push(`model: ${summary.filter.model}`);

	const lines = [
		titleParts.join(" • "),
		`Cost: ${formatCost(summary.totalCost)}${summary.tokenOnlyCalls ? ` (${summary.tokenOnlyCalls} token-only calls)` : ""}`,
		`Tokens: ${formatTokens(summary.totalTokens)} total  ↑${formatTokens(summary.input)}  ↓${formatTokens(summary.output)}  R${formatTokens(summary.cacheRead)}  W${formatTokens(summary.cacheWrite)}`,
		`Calls: ${summary.calls}  Projects: ${summary.projects}  Models: ${summary.models}`,
	];

	if (summary.skippedLines) lines.push(`Skipped corrupt ledger lines: ${summary.skippedLines}`);
	return lines.join("\n");
}

function formatHelp(json: boolean): string {
	const help = {
		usage: "/usage [subcommand] [options]",
		subcommands: [
			{ command: "/usage", description: "Show month-to-date summary" },
			{ command: "/usage today", description: "Show today's summary" },
			{ command: "/usage week", description: "Show current week summary" },
			{ command: "/usage month", description: "Show current month summary" },
			{ command: "/usage lifetime", description: "Show lifetime summary" },
			{ command: "/usage project --list", description: "List recorded projects" },
			{ command: "/usage project <project>", description: "Show lifetime usage for a project" },
			{ command: "/usage model --list", description: "List recorded models" },
			{ command: "/usage model <model>", description: "Show lifetime usage for a model" },
			{ command: "/usage skills [range]", description: "Show skill usage counts" },
			{ command: "/usage skills --project", description: "Group skill usage by project" },
			{ command: "/usage clear", description: "Clear the usage ledger after confirmation" },
		],
		options: [
			{ option: "--project <project>", description: "Filter a time range or skill report by project" },
			{ option: "--project", description: "With /usage skills, group skill usage by project" },
			{ option: "--model <model>", description: "Filter a time range by model" },
			{ option: "--list", description: "List values for project/model commands" },
			{ option: "--json", description: "Emit machine-readable JSON" },
			{ option: "-y, --yes", description: "Skip confirmation for /usage clear" },
			{ option: "-h, --help", description: "Show this help" },
		],
	};

	if (json) return JSON.stringify({ ok: true, help }, null, 2);

	return [
		"Usage ledger commands",
		"",
		...help.subcommands.map((item) => `${item.command.padEnd(32)} ${item.description}`),
		"",
		"Options",
		...help.options.map((item) => `${item.option.padEnd(22)} ${item.description}`),
	].join("\n");
}

function formatList(kind: "project" | "model", items: string[], skippedLines: number): string {
	const title = kind === "project" ? "Recorded projects" : "Recorded models";
	const lines = [title, ...(items.length ? items.map((item) => `- ${item}`) : ["No usage records found."])] ;
	if (skippedLines) lines.push(`Skipped corrupt ledger lines: ${skippedLines}`);
	return lines.join("\n");
}

function countSkillReads(records: SkillReadRecord[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const record of records) counts.set(record.skill.name, (counts.get(record.skill.name) ?? 0) + 1);
	return counts;
}

function sortedCounts(counts: Map<string, number>): Array<[string, number]> {
	return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function filterSkillReads(records: SkillReadRecord[], options: { range: UsageRange; project?: string }): SkillReadRecord[] {
	return records.filter((record) => {
		if (!inRange({ timestamp: record.timestamp } as UsageLedgerRecord, options.range)) return false;
		if (options.project && !matchesSkillReadProject(record, options.project)) return false;
		return true;
	});
}

function formatSkillUsageSummary(records: SkillReadRecord[], options: { range: UsageRange; project?: string; skippedLines: number }): string {
	const filtered = filterSkillReads(records, options);
	const counts = sortedCounts(countSkillReads(filtered));
	const titleParts = [`Usage — Skills`, titleForRange(options.range)];
	if (options.project) titleParts.push(`project: ${options.project}`);
	const lines = [
		titleParts.join(" • "),
		`Skill invocations: ${filtered.length}  Projects: ${new Set(filtered.map(getSkillReadProjectKey)).size}`,
		"",
		"Skills:",
		...(counts.length ? counts.map(([name, count]) => `- ${name}: ${count}`) : ["No skill reads found."]),
	];
	if (options.skippedLines) lines.push(`Skipped corrupt skill-read ledger lines: ${options.skippedLines}`);
	return lines.join("\n");
}

function formatSkillUsageByProject(records: SkillReadRecord[], options: { range: UsageRange; skippedLines: number }): string {
	const filtered = filterSkillReads(records, { range: options.range });
	const byProject = new Map<string, SkillReadRecord[]>();
	for (const record of filtered) {
		const key = getSkillReadProjectKey(record);
		byProject.set(key, [...(byProject.get(key) ?? []), record]);
	}

	const projectEntries = Array.from(byProject.entries()).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
	const lines = [`Usage — Skills by project • ${titleForRange(options.range)}`];
	if (!projectEntries.length) lines.push("", "No skill reads found.");
	for (const [project, projectRecords] of projectEntries) {
		lines.push("", `${project} — ${projectRecords.length} invocations`);
		for (const [name, count] of sortedCounts(countSkillReads(projectRecords))) lines.push(`- ${name}: ${count}`);
	}
	if (options.skippedLines) lines.push(`Skipped corrupt skill-read ledger lines: ${options.skippedLines}`);
	return lines.join("\n");
}

function summarizeSkillUsage(records: SkillReadRecord[], options: { range: UsageRange; project?: string; groupByProject?: boolean; skippedLines: number }) {
	const filtered = filterSkillReads(records, { range: options.range, project: options.project });
	const bySkill = Object.fromEntries(sortedCounts(countSkillReads(filtered)));
	if (!options.groupByProject) {
		return {
			range: options.range,
			filter: { project: options.project },
			invocations: filtered.length,
			projects: new Set(filtered.map(getSkillReadProjectKey)).size,
			skills: bySkill,
			skippedLines: options.skippedLines,
		};
	}

	const projects: Record<string, { invocations: number; skills: Record<string, number> }> = {};
	for (const project of Array.from(new Set(filtered.map(getSkillReadProjectKey))).sort((a, b) => a.localeCompare(b))) {
		const projectRecords = filtered.filter((record) => getSkillReadProjectKey(record) === project);
		projects[project] = { invocations: projectRecords.length, skills: Object.fromEntries(sortedCounts(countSkillReads(projectRecords))) };
	}
	return { range: options.range, groupByProject: true, invocations: filtered.length, projects, skippedLines: options.skippedLines };
}

async function ensureLedgerDir(): Promise<void> {
	await fs.mkdir(ledgerDir, { recursive: true });
}

async function appendLedgerRecord(record: UsageLedgerRecord): Promise<void> {
	await ensureLedgerDir();
	// Append complete JSON objects atomically enough for v1. If concurrent Pi
	// instances ever corrupt or interleave writes, the planned escape hatch is SQLite.
	await fs.appendFile(ledgerPath, `${JSON.stringify(record)}\n`, "utf8");
}

function isUsageLedgerRecord(value: any): value is UsageLedgerRecord {
	return value && value.version === schemaVersion && value.source === "live" && value.usage && typeof value.usage.totalTokens === "number";
}

async function clearLedger(): Promise<boolean> {
	try {
		await fs.unlink(ledgerPath);
		seenRecordIds.clear();
		return true;
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			seenRecordIds.clear();
			return false;
		}
		throw error;
	}
}

async function readLedgerRecords(): Promise<LedgerReadResult> {
	// A missing ledger means tracking has not recorded anything yet; commands should
	// show zero usage instead of surfacing a filesystem error.
	let text: string;
	try {
		text = await fs.readFile(ledgerPath, "utf8");
	} catch (error: any) {
		if (error?.code === "ENOENT") return { records: [], skippedLines: 0 };
		throw error;
	}

	const records: UsageLedgerRecord[] = [];
	let skippedLines = 0;

	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line);
			if (isUsageLedgerRecord(parsed)) records.push(parsed);
			else skippedLines += 1;
		} catch {
			// Preserve availability: one bad line should not make all usage commands fail.
			skippedLines += 1;
		}
	}

	return { records, skippedLines };
}

function isSkillReadRecord(value: any): value is SkillReadRecord {
	return value && value.version === schemaVersion && typeof value.id === "string" && value.skill && typeof value.skill.name === "string";
}

async function readSkillReadRecords(): Promise<SkillReadLedgerReadResult> {
	let text: string;
	try {
		text = await fs.readFile(skillReadLedgerPath, "utf8");
	} catch (error: any) {
		if (error?.code === "ENOENT") return { records: [], skippedLines: 0 };
		throw error;
	}

	const records: SkillReadRecord[] = [];
	let skippedLines = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line);
			if (isSkillReadRecord(parsed)) records.push(parsed);
			else skippedLines += 1;
		} catch {
			skippedLines += 1;
		}
	}
	return { records, skippedLines };
}

// Git metadata is best-effort. Non-git directories, detached remotes, or slow git
// commands should produce null fields rather than blocking usage capture.
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

// Normalize common SSH/HTTPS remote forms to a stable grouping key, e.g.
// git@github.com:user/repo.git and https://github.com/user/repo -> github.com/user/repo.
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

function getCwd(ctx: ExtensionContext): string | null {
	return ctx.cwd ?? (ctx.sessionManager.getCwd?.() as string | undefined) ?? process.cwd();
}

function isoFromTimestamp(timestamp: unknown): string {
	if (typeof timestamp === "number" && Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
	if (typeof timestamp === "string") {
		const date = new Date(timestamp);
		if (Number.isFinite(date.getTime())) return date.toISOString();
	}
	return new Date().toISOString();
}

function usageMatches(a: any, b: any): boolean {
	return (
		a?.input === b?.input &&
		a?.output === b?.output &&
		a?.cacheRead === b?.cacheRead &&
		a?.cacheWrite === b?.cacheWrite &&
		a?.totalTokens === b?.totalTokens
	);
}

// message_end currently gives us the message but not the session entry id. Walk
// backward through session entries to find the just-finalized assistant message.
function findSessionEntryId(ctx: ExtensionContext, message: any): string | null {
	const entries = (ctx.sessionManager.getEntries?.() ?? []) as SessionEntry[];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		if (entry.message === message) return entry.id ?? null;
		if (entry.message?.timestamp === message.timestamp && entry.message?.model === message.model && usageMatches(entry.message.usage, message.usage)) {
			return entry.id ?? null;
		}
	}
	return null;
}

// Build the persistent record from Pi's assistant message. Project metadata is
// filled in after this by getProjectInfo because it requires async git commands.
function buildRecord(ctx: ExtensionContext, message: any): UsageLedgerRecord {
	const cwd = getCwd(ctx);
	const sessionFile = ctx.sessionManager.getSessionFile?.() ?? null;
	const sessionEntryId = findSessionEntryId(ctx, message);
	const timestamp = isoFromTimestamp(message.timestamp);
	const id = `${sessionFile ?? "ephemeral"}:${sessionEntryId ?? timestamp}`;
	const usage = message.usage;
	// Pi already decides whether a provider/model has meaningful cost metadata. Use
	// the reported total when present, even for OAuth/subscription-backed providers;
	// fall back to null only when Pi does not provide a numeric estimate.
	const totalCost = typeof usage.cost?.total === "number" ? usage.cost.total : null;

	return {
		version: schemaVersion,
		id,
		source: "live",
		timestamp,
		recordedAt: new Date().toISOString(),
		sessionFile,
		sessionEntryId,
		cwd,
		project: { name: null, gitRemote: null, gitRoot: null, gitCommonDir: null },
		provider: message.provider ?? (ctx as any).model?.provider ?? null,
		model: message.model ?? (ctx as any).model?.id ?? null,
		api: message.api ?? (ctx as any).model?.api ?? null,
		usage: {
			input: usage.input ?? 0,
			output: usage.output ?? 0,
			cacheRead: usage.cacheRead ?? 0,
			cacheWrite: usage.cacheWrite ?? 0,
			totalTokens: usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
			totalCost,
		},
	};
}

async function notifyOutput(ctx: ExtensionContext, text: string, _json: boolean): Promise<void> {
	ctx.ui.notify(text, "info");
}

// Single command handler for all /usage subcommands. It reads the raw ledger each
// time so JSONL remains the only source of truth.
async function handleUsageCommand(args: string, ctx: ExtensionContext): Promise<void> {
	const parsed = parseUsageArgs(args);
	if (parsed.help) {
		await notifyOutput(ctx, formatHelp(parsed.json), parsed.json);
		return;
	}

	if (parsed.error) {
		await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: false, error: parsed.error }, null, 2) : parsed.error, parsed.json);
		return;
	}

	if (parsed.mode === "clear") {
		if (!parsed.yes) {
			if (!ctx.hasUI) {
				const error = "Refusing to clear usage ledger without UI confirmation. Re-run with /usage clear --yes.";
				await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: false, error }, null, 2) : error, parsed.json);
				return;
			}

			const confirmed = await ctx.ui.confirm(
				"Clear usage ledger?",
				`Delete all recorded usage from ${ledgerPath}? This cannot be undone.`,
			);
			if (!confirmed) {
				await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: false, cancelled: true }, null, 2) : "Usage ledger clear cancelled.", parsed.json);
				return;
			}
		}

		const deleted = await clearLedger();
		await notifyOutput(
			ctx,
			parsed.json ? JSON.stringify({ ok: true, deleted, ledgerPath }, null, 2) : deleted ? "Usage ledger cleared." : "Usage ledger was already empty.",
			parsed.json,
		);
		return;
	}

	if (parsed.mode === "skills") {
		const { records, skippedLines } = await readSkillReadRecords();
		if (parsed.project && !records.some((record) => matchesSkillReadProject(record, parsed.project!))) {
			const projects = Array.from(new Set(records.map(getSkillReadProjectKey))).sort((a, b) => a.localeCompare(b));
			const error = `No skill read records found for project "${parsed.project}". Try /usage skills --project.`;
			await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: false, error, projects, skippedLines }, null, 2) : error, parsed.json);
			return;
		}

		const summary = summarizeSkillUsage(records, { range: parsed.range, project: parsed.project, groupByProject: parsed.groupByProject, skippedLines });
		const text = parsed.groupByProject
			? formatSkillUsageByProject(records, { range: parsed.range, skippedLines })
			: formatSkillUsageSummary(records, { range: parsed.range, project: parsed.project, skippedLines });
		await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: true, summary }, null, 2) : text, parsed.json);
		return;
	}

	const { records, skippedLines } = await readLedgerRecords();

	if (parsed.mode === "project" && parsed.list) {
		const projects = listProjects(records);
		await notifyOutput(
			ctx,
			parsed.json ? JSON.stringify({ ok: true, projects, skippedLines }, null, 2) : formatList("project", projects, skippedLines),
			parsed.json,
		);
		return;
	}

	if (parsed.mode === "model" && parsed.list) {
		const models = listModels(records);
		await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: true, models, skippedLines }, null, 2) : formatList("model", models, skippedLines), parsed.json);
		return;
	}

	if (parsed.project && !records.some((record) => matchesProject(record, parsed.project!))) {
		const error = `No usage records found for project "${parsed.project}". Try /usage project --list.`;
		await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: false, error, projects: listProjects(records), skippedLines }, null, 2) : error, parsed.json);
		return;
	}

	if (parsed.model && !records.some((record) => matchesModel(record, parsed.model!))) {
		const error = `No usage records found for model "${parsed.model}". Try /usage model --list.`;
		await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: false, error, models: listModels(records), skippedLines }, null, 2) : error, parsed.json);
		return;
	}

	const summary = summarizeRecords(records, { range: parsed.range, project: parsed.project, model: parsed.model, skippedLines });
	await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: true, summary }, null, 2) : formatSummary(summary), parsed.json);
}

export default function (pi: ExtensionAPI) {
	pi.on("message_end", async (event, ctx) => {
		// Only assistant responses have provider usage. Tool results and user messages
		// are ignored; additional assistant turns caused by tool calls are counted if
		// Pi emits usage for them.
		if (event.message.role !== "assistant") return;
		if (!event.message.usage) return;

		const record = buildRecord(ctx, event.message);
		// Protect against duplicate event delivery within this process. Cross-process
		// dedupe is intentionally deferred unless/until we move to SQLite.
		if (seenRecordIds.has(record.id)) return;

		if (record.cwd) record.project = await getProjectInfo(record.cwd);
		await appendLedgerRecord(record);
		seenRecordIds.add(record.id);
	});

	pi.registerCommand("usage", {
		description: "Show cross-session token usage and estimated spending",
		handler: async (args, ctx) => {
			try {
				await handleUsageCommand(args, ctx);
			} catch (error: any) {
				ctx.ui.notify(`Usage ledger error: ${error?.message ?? String(error)}`, "error");
			}
		},
	});
}
