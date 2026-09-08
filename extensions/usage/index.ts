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
import { fetchCodexUsageLimits, formatCodexUsageLimits, type CodexUsageLimits } from "../../src/shared/codex-usage-limits.ts";
import { mergeUsageProjectAttribution, normalizeGitRemote, normalizeUsageTags, readUsageConfig, type UsageConfig } from "../../src/shared/usage-attribution.ts";
import { getInheritedUsageTags, getUsageSessionState, usageSessionCustomType, type UsageSessionProject, type UsageSessionState } from "../../src/shared/usage-session.ts";

const execFileAsync = promisify(execFile);
const ledgerDir = path.join(os.homedir(), ".pi", "agent", "usage");
const ledgerPath = path.join(ledgerDir, "ledger.jsonl");
const skillReadLedgerPath = path.join(os.homedir(), ".pi", "agent", "skill-reads", "ledger.jsonl");
const schemaVersion = 1;

type UsageRange = "today" | "week" | "month" | "lifetime";
type UsageMode = "summary" | "report" | "project" | "model" | "skills" | "clear" | "tag";

type ProjectInfo = UsageSessionProject;

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
	tags?: string[];
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
	visual: boolean;
	list: boolean;
	help: boolean;
	yes: boolean;
	tagClear?: boolean;
	tagRemove?: string;
	tags?: string[];
	project?: string;
	groupByProject?: boolean;
	model?: string;
	branch?: string;
	selectBranch?: boolean;
	error?: string;
};

type UsageSummary = {
	range: UsageRange;
	filter?: { project?: string; model?: string; branch?: string };
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

type UsageReportGroup = {
	key: string;
	calls: number;
	totalTokens: number;
	totalCost: number;
	tokenOnlyCalls: number;
};

type UsageTagBreakdown = UsageReportGroup;

type UsageReport = {
	range: UsageRange;
	filter?: { project?: string; model?: string; branch?: string };
	overview: UsageSummary;
	providers: UsageReportGroup[];
	models: UsageReportGroup[];
	projects: UsageReportGroup[];
	tags?: UsageTagBreakdown[];
	topRecords: Array<{
		timestamp: string;
		project: string;
		provider: string;
		model: string;
		totalTokens: number;
		totalCost: number | null;
	}>;
	skippedLines: number;
};

type SessionEntry = {
	type: string;
	id?: string;
	message?: any;
	customType?: string;
	data?: unknown;
};

const legacyUsageTagCustomType = "usage-tags";

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

function parseTags(value: string): string[] {
	return normalizeUsageTags(value.split(","));
}

function formatTags(tags: string[]): string {
	return tags.length ? `Active usage tags: ${tags.join(", ")}` : "No active usage tags.";
}

// Parse the intentionally small command grammar into one normalized shape so
// execution can be shared across text and JSON output modes.
function parseUsageArgs(args: string): ParsedUsageCommand {
	const tokens = tokenizeArgs(args);
	const command: ParsedUsageCommand = { mode: "summary", range: "month", json: false, visual: false, list: false, help: false, yes: false };
	const positionals: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];

		if (token === "--json") {
			command.json = true;
			continue;
		}

		if (token === "--visual") {
			command.visual = true;
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

		if (token === "--clear") {
			command.tagClear = true;
			continue;
		}

		if (token === "--remove") {
			const value = tokens[++i];
			if (!value) return { ...command, error: "Missing value for --remove" };
			command.tagRemove = value;
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

		if (token === "--branch") {
			const value = tokens[i + 1];
			if (!value || value.startsWith("--")) {
				command.selectBranch = true;
			} else {
				command.branch = value;
				i += 1;
			}
			continue;
		}

		if (token.startsWith("--")) return { ...command, error: `Unknown option: ${token}` };
		positionals.push(token);
	}

	const first = positionals[0];
	if (!first) {
		if (command.tagClear || command.tagRemove) return { ...command, error: "--clear and --remove are only supported by /usage tag" };
		if (command.groupByProject) return { ...command, error: "Missing value for --project" };
		return command;
	}
	if (first !== "tag" && (command.tagClear || command.tagRemove)) return { ...command, error: "--clear and --remove are only supported by /usage tag" };

	if (first === "report") {
		command.mode = "report";
		if (positionals.length > 1) {
			const range = positionals[1];
			if (!["today", "week", "month", "lifetime"].includes(range)) return { ...command, error: `Unknown report range: ${range}` };
			command.range = range as UsageRange;
		}
		if (positionals.length > 2) return { ...command, error: `Unexpected argument: ${positionals[2]}` };
		if (command.groupByProject) return { ...command, error: "Missing value for --project" };
		return command;
	}

	if (first === "project") {
		command.mode = "project";
		command.range = "lifetime";
		if (positionals.length > 1) command.project = positionals.slice(1).join(" ");
		if (command.groupByProject) return { ...command, error: "Missing value for --project" };
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

	if (first === "tag") {
		command.mode = "tag";
		if (command.groupByProject || command.project || command.model || command.branch || command.selectBranch || command.visual || command.yes) {
			return { ...command, error: "Tag commands only support --clear, --remove, --list, and --json" };
		}
		if (command.tagClear && (command.tagRemove || command.list || positionals.length > 1)) return { ...command, error: "Use --clear by itself" };
		if (command.tagRemove && (command.list || positionals.length > 1)) return { ...command, error: "Use --remove with one tag name" };
		if (command.list && positionals.length > 1) return { ...command, error: "Use --list by itself" };
		if (!command.tagClear && !command.tagRemove && !command.list) {
			const tags = parseTags(positionals.slice(1).join(" "));
			if (!tags.length) return { ...command, error: "Usage: /usage tag <comma-separated tags>" };
			command.tags = tags;
		}
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
function getProjectKeyFor(project: ProjectInfo, cwd: string | null): string {
	return project.gitRemote ?? project.gitCommonDir ?? project.gitRoot ?? cwd ?? "unknown";
}

function getProjectKey(record: UsageLedgerRecord): string {
	return getProjectKeyFor(record.project, record.cwd);
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

function matchesBranch(record: UsageLedgerRecord, branch: string): boolean {
	return record.project.gitBranch === branch || branchLabel(record.project.gitBranch) === branch;
}

function filterRecords(records: UsageLedgerRecord[], options: { range: UsageRange; project?: string; model?: string; branch?: string }): UsageLedgerRecord[] {
	return records.filter((record) => {
		if (!inRange(record, options.range)) return false;
		if (options.project && !matchesProject(record, options.project)) return false;
		if (options.model && !matchesModel(record, options.model)) return false;
		if (options.branch && !matchesBranch(record, options.branch)) return false;
		return true;
	});
}

// Summaries are derived from raw records on demand. Token-only records count
// toward tokens/calls but intentionally do not add to totalCost.
function summarizeRecords(
	records: UsageLedgerRecord[],
	options: { range: UsageRange; project?: string; model?: string; branch?: string; skippedLines?: number },
): UsageSummary {
	const filtered = filterRecords(records, options);

	const summary: UsageSummary = {
		range: options.range,
		filter: { project: options.project, model: options.model, branch: options.branch },
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

function formatSummary(summary: UsageSummary, tags: UsageTagBreakdown[] = []): string {
	const titleParts = [`Usage — ${titleForRange(summary.range)}`];
	if (summary.filter?.project) titleParts.push(`project: ${summary.filter.project}`);
	if (summary.filter?.branch) titleParts.push(`branch: ${summary.filter.branch}`);
	if (summary.filter?.model) titleParts.push(`model: ${summary.filter.model}`);

	const lines = [
		titleParts.join(" • "),
		`Cost: ${formatCost(summary.totalCost)}${summary.tokenOnlyCalls ? ` (${summary.tokenOnlyCalls} token-only calls)` : ""}`,
		`Tokens: ${formatTokens(summary.totalTokens)} total  ↑${formatTokens(summary.input)}  ↓${formatTokens(summary.output)}  R${formatTokens(summary.cacheRead)}  W${formatTokens(summary.cacheWrite)}`,
		`Calls: ${summary.calls}  Projects: ${summary.projects}  Models: ${summary.models}`,
	];

	if (tags.length) lines.push("", "Tags", ...formatTagBreakdownLines(tags));
	if (summary.skippedLines) lines.push(`Skipped corrupt ledger lines: ${summary.skippedLines}`);
	return lines.join("\n");
}

function branchLabel(branch: string | null | undefined): string {
	return branch || "untracked";
}

function groupProjectRecordsByBranch(records: UsageLedgerRecord[], project: string): Array<{ branch: string | null; label: string; summary: UsageSummary }> {
	const projectRecords = filterRecords(records, { range: "lifetime", project });
	const branches = new Map<string, string | null>();
	for (const record of projectRecords) {
		const branch = record.project.gitBranch ?? null;
		branches.set(branch ?? "", branch);
	}

	return Array.from(branches.values())
		.map((branch) => {
			const branchRecords = projectRecords.filter((record) => (record.project.gitBranch ?? null) === branch);
			return {
				branch,
				label: branchLabel(branch),
				summary: summarizeRecords(branchRecords, { range: "lifetime" }),
			};
		})
		.sort((a, b) => b.summary.totalTokens - a.summary.totalTokens || a.label.localeCompare(b.label));
}

function tagBreakdown(records: UsageLedgerRecord[]): UsageTagBreakdown[] {
	const tags = new Map<string, UsageTagBreakdown>();
	for (const record of records) {
		for (const tag of normalizeUsageTags(record.tags ?? [])) addReportGroup(tags, tag, record);
	}
	return sortedReportGroups(tags);
}

function formatTagBreakdownLines(tags: UsageTagBreakdown[]): string[] {
	return tags.map((tag) => {
		const tokenOnly = tag.tokenOnlyCalls ? `, ${tag.tokenOnlyCalls} token-only` : "";
		return `- ${tag.key} — ${formatCost(tag.totalCost)}, ${formatTokens(tag.totalTokens)} tokens, ${tag.calls} calls${tokenOnly}`;
	});
}

function buildProjectUsageReport(records: UsageLedgerRecord[], options: { project: string; skippedLines: number }) {
	const projectRecords = filterRecords(records, { range: "lifetime", project: options.project });
	const overview = summarizeRecords(records, { range: "lifetime", project: options.project, skippedLines: options.skippedLines });
	return {
		project: options.project,
		range: "lifetime" as UsageRange,
		overview,
		branches: groupProjectRecordsByBranch(records, options.project),
		tags: tagBreakdown(projectRecords),
		skippedLines: options.skippedLines,
	};
}

function formatProjectUsageReport(records: UsageLedgerRecord[], options: { project: string; skippedLines: number }): string {
	const report = buildProjectUsageReport(records, options);
	const lines = [
		`Usage for project ${options.project} — ${titleForRange(report.range)}`,
		"",
		"Overview",
		`Cost: ${formatCost(report.overview.totalCost)}${report.overview.tokenOnlyCalls ? ` (${report.overview.tokenOnlyCalls} token-only calls)` : ""}`,
		`Tokens: ${formatTokens(report.overview.totalTokens)} total  ↑${formatTokens(report.overview.input)}  ↓${formatTokens(report.overview.output)}  R${formatTokens(report.overview.cacheRead)}  W${formatTokens(report.overview.cacheWrite)}`,
		`Calls: ${report.overview.calls}  Models: ${report.overview.models}`,
		"",
		"Branches",
	];

	if (report.branches.length) {
		for (const entry of report.branches) {
			lines.push(`- ${entry.label} — ${entry.summary.calls} calls, ${formatTokens(entry.summary.totalTokens)} tokens, ${formatCost(entry.summary.totalCost)}`);
		}
	} else {
		lines.push("No usage records found.");
	}

	if (report.tags.length) lines.push("", "Tags", ...formatTagBreakdownLines(report.tags));
	if (options.skippedLines) lines.push(`Skipped corrupt ledger lines: ${options.skippedLines}`);
	return lines.join("\n");
}

function addReportGroup(map: Map<string, UsageReportGroup>, key: string, record: UsageLedgerRecord): void {
	const entry = map.get(key) ?? { key, calls: 0, totalTokens: 0, totalCost: 0, tokenOnlyCalls: 0 };
	entry.calls += 1;
	entry.totalTokens += record.usage.totalTokens;
	if (typeof record.usage.totalCost === "number") entry.totalCost += record.usage.totalCost;
	else entry.tokenOnlyCalls += 1;
	map.set(key, entry);
}

function sortedReportGroups(map: Map<string, UsageReportGroup>): UsageReportGroup[] {
	return Array.from(map.values()).sort((a, b) => b.totalCost - a.totalCost || b.totalTokens - a.totalTokens || a.key.localeCompare(b.key));
}

function buildUsageReport(records: UsageLedgerRecord[], options: { range: UsageRange; project?: string; model?: string; branch?: string; skippedLines: number }): UsageReport {
	const filtered = filterRecords(records, options);
	const providers = new Map<string, UsageReportGroup>();
	const models = new Map<string, UsageReportGroup>();
	const projects = new Map<string, UsageReportGroup>();

	for (const record of filtered) {
		addReportGroup(providers, record.provider ?? "unknown", record);
		addReportGroup(models, getModelKey(record), record);
		addReportGroup(projects, getProjectKey(record), record);
	}

	return {
		range: options.range,
		filter: { project: options.project, model: options.model, branch: options.branch },
		overview: summarizeRecords(records, options),
		providers: sortedReportGroups(providers),
		models: sortedReportGroups(models),
		projects: sortedReportGroups(projects),
		tags: tagBreakdown(filtered),
		topRecords: filtered
			.filter((record) => typeof record.usage.totalCost === "number")
			.sort((a, b) => (b.usage.totalCost ?? 0) - (a.usage.totalCost ?? 0) || b.usage.totalTokens - a.usage.totalTokens)
			.slice(0, 10)
			.map((record) => ({
				timestamp: record.timestamp,
				project: getProjectKey(record),
				provider: record.provider ?? "unknown",
				model: getModelKey(record),
				totalTokens: record.usage.totalTokens,
				totalCost: record.usage.totalCost,
			})),
		skippedLines: options.skippedLines,
	};
}

function formatReportGroupLines(groups: UsageReportGroup[], emptyText: string): string[] {
	if (!groups.length) return [emptyText];
	return groups.slice(0, 10).map((group) => {
		const tokenOnly = group.tokenOnlyCalls ? `, ${group.tokenOnlyCalls} token-only` : "";
		return `- ${group.key} — ${formatCost(group.totalCost)}, ${formatTokens(group.totalTokens)} tokens, ${group.calls} calls${tokenOnly}`;
	});
}

function formatUsageReport(records: UsageLedgerRecord[], options: { range: UsageRange; project?: string; model?: string; branch?: string; skippedLines: number }): string {
	const report = buildUsageReport(records, options);
	const titleParts = [`Usage report — ${titleForRange(report.range)}`];
	if (options.project) titleParts.push(`project: ${options.project}`);
	if (options.branch) titleParts.push(`branch: ${options.branch}`);
	if (options.model) titleParts.push(`model: ${options.model}`);

	const lines = [
		titleParts.join(" • "),
		`Total: ${formatCost(report.overview.totalCost)} across ${report.overview.calls} calls, ${formatTokens(report.overview.totalTokens)} tokens`,
		"",
		"By provider",
		...formatReportGroupLines(report.providers, "No provider usage records found."),
		"",
		"By model",
		...formatReportGroupLines(report.models, "No model usage records found."),
		"",
		"By project",
		...formatReportGroupLines(report.projects, "No project usage records found."),
		...(report.tags?.length ? ["", "By tag", ...formatTagBreakdownLines(report.tags)] : []),
		"",
		"Top cost records",
	];

	if (report.topRecords.length) {
		for (const record of report.topRecords) {
			lines.push(`- ${record.timestamp} — ${formatCost(record.totalCost ?? 0)}, ${formatTokens(record.totalTokens)} tokens, ${record.model}, ${record.project}`);
		}
	} else {
		lines.push("No costed records found.");
	}

	if (report.overview.tokenOnlyCalls) lines.push(`Token-only calls: ${report.overview.tokenOnlyCalls}`);
	if (options.skippedLines) lines.push(`Skipped corrupt ledger lines: ${options.skippedLines}`);
	return lines.join("\n");
}

function formatPercent(value: number, total: number): string {
	if (total <= 0) return "0%";
	const percent = (value / total) * 100;
	return `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
}

function formatBar(value: number, max: number, width = 24): string {
	if (max <= 0 || value <= 0) return "░".repeat(width);
	const filled = Math.max(1, Math.round((value / max) * width));
	return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

function formatVisualGroup(title: string, groups: UsageReportGroup[]): string[] {
	const visible = groups.slice(0, 10);
	const maxCost = Math.max(...visible.map((group) => group.totalCost), 0);
	const totalCost = groups.reduce((sum, group) => sum + group.totalCost, 0);
	const lines = [title];
	if (!visible.length) return [...lines, "No usage records found."];

	const labelWidth = Math.min(32, Math.max(...visible.map((group) => group.key.length), 10));
	for (const group of visible) {
		const label = group.key.length > labelWidth ? `${group.key.slice(0, labelWidth - 1)}…` : group.key.padEnd(labelWidth);
		const tokenOnly = group.tokenOnlyCalls ? `  token-only:${group.tokenOnlyCalls}` : "";
		lines.push(`${label}  ${formatBar(group.totalCost, maxCost)}  ${formatCost(group.totalCost).padStart(8)}  ${formatPercent(group.totalCost, totalCost).padStart(5)}  ${formatTokens(group.totalTokens).padStart(6)} tok  ${group.calls} calls${tokenOnly}`);
	}
	return lines;
}

function formatVisualUsageReport(records: UsageLedgerRecord[], options: { range: UsageRange; project?: string; model?: string; branch?: string; skippedLines: number }): string {
	const report = buildUsageReport(records, options);
	const titleParts = [`Usage graph — ${titleForRange(report.range)}`];
	if (options.project) titleParts.push(`project: ${options.project}`);
	if (options.branch) titleParts.push(`branch: ${options.branch}`);
	if (options.model) titleParts.push(`model: ${options.model}`);

	const lines = [
		titleParts.join(" • "),
		`Total ${formatCost(report.overview.totalCost)} • ${report.overview.calls} calls • ${formatTokens(report.overview.totalTokens)} tokens${report.overview.tokenOnlyCalls ? ` • ${report.overview.tokenOnlyCalls} token-only calls` : ""}`,
		"",
		...formatVisualGroup("By project", report.projects),
		"",
		...formatVisualGroup("By provider", report.providers),
		"",
		...formatVisualGroup("By model", report.models),
		...(report.tags?.length ? ["", ...formatVisualGroup("By tag", report.tags)] : []),
	];

	if (options.skippedLines) lines.push("", `Skipped corrupt ledger lines: ${options.skippedLines}`);
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
			{ command: "/usage report [range]", description: "Show spend grouped by provider, model, project, and top cost records" },
			{ command: "/usage report --visual", description: "Show static horizontal spend graphs by project, provider, and model" },
			{ command: "/usage project", description: "Select a recorded project and show lifetime usage" },
			{ command: "/usage project --list", description: "List recorded projects" },
			{ command: "/usage project <project>", description: "Show lifetime usage overview, branch breakdown, and available tags" },
			{ command: "/usage project <project> --branch", description: "Show usage for the current branch and its available tags" },
			{ command: "/usage model --list", description: "List recorded models" },
			{ command: "/usage model <model>", description: "Show lifetime usage for a model" },
			{ command: "/usage skills [range]", description: "Show skill usage counts" },
			{ command: "/usage skills --project", description: "Group skill usage by project" },
			{ command: "/usage openai", description: "Fetch current OpenAI Codex subscription limits" },
			{ command: "/usage tag <comma-separated tags>", description: "Add arbitrary tags to subsequent usage in this session" },
			{ command: "/usage tag --remove <tag>", description: "Remove one active usage tag" },
			{ command: "/usage tag --clear", description: "Clear active usage tags" },
			{ command: "/usage tag --list", description: "List active usage tags" },
			{ command: "/usage clear", description: "Clear the usage ledger after confirmation" },
		],
		options: [
			{ option: "--project <project>", description: "Filter a time range or skill report by project" },
			{ option: "--project", description: "With /usage skills, group skill usage by project" },
			{ option: "--model <model>", description: "Filter a time range by model" },
			{ option: "--branch [branch]", description: "Filter by local git branch; without a value, defaults to the current workspace project and branch" },
			{ option: "--list", description: "List values for project/model/tag commands" },
			{ option: "--json", description: "Emit machine-readable JSON" },
			{ option: "--visual", description: "With /usage report, show static horizontal bar charts" },
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
	const gitBranch = await git(cwd, ["branch", "--show-current"]);
	const project: ProjectInfo = { name: null, gitRemote: remote, gitRoot, gitCommonDir, gitBranch };
	project.name = deriveProjectName(project, cwd);
	return project;
}

function applyProjectAttributionOverride(project: ProjectInfo, cwd: string, config: UsageConfig | null): ProjectInfo {
	const attribution = mergeUsageProjectAttribution({ gitRemote: project.gitRemote ?? undefined, gitBranch: project.gitBranch ?? undefined }, config?.project ?? null);
	const attributed: ProjectInfo = {
		...project,
		gitRemote: attribution.gitRemote ? normalizeGitRemote(attribution.gitRemote) : null,
		gitBranch: attribution.gitBranch ?? null,
	};
	attributed.name = deriveProjectName(attributed, cwd);
	return attributed;
}

function getCwd(ctx: ExtensionContext): string | null {
	return ctx.cwd ?? (ctx.sessionManager.getCwd?.() as string | undefined) ?? process.cwd();
}

// Match the attribution used for new ledger records so a bare --branch filters
// the project currently open in Pi, including any local project override.
async function getCurrentUsageProject(ctx: ExtensionContext): Promise<{ project: ProjectInfo; cwd: string | null }> {
	const cwd = getCwd(ctx);
	if (!cwd) return { project: { name: null, gitRemote: null, gitRoot: null, gitCommonDir: null, gitBranch: null }, cwd: null };

	const project = await getProjectInfo(cwd);
	try {
		return { project: applyProjectAttributionOverride(project, cwd, await readUsageConfig(cwd)), cwd };
	} catch (error: any) {
		console.warn(`Usage tracker ignored local usage config: ${error?.message ?? String(error)}`);
		return { project, cwd };
	}
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
function buildRecord(ctx: ExtensionContext, message: any, usageSession: UsageSessionState): UsageLedgerRecord {
	const cwd = usageSession.cwd;
	const sessionFile = usageSession.sessionFile;
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
		project: usageSession.project,
		...(usageSession.tags.length ? { tags: [...usageSession.tags] } : {}),
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

	if ((parsed.branch || parsed.selectBranch) && (parsed.mode === "skills" || parsed.mode === "clear" || parsed.list)) {
		const error = "--branch is only supported for project usage reports and project-filtered usage summaries.";
		await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: false, error }, null, 2) : error, parsed.json);
		return;
	}

	if ((parsed.mode === "summary" || parsed.mode === "report") && parsed.branch && !parsed.project) {
		const error = "--branch requires --project or /usage project <project>.";
		await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: false, error }, null, 2) : error, parsed.json);
		return;
	}

	if (parsed.visual && parsed.mode !== "report") {
		const error = "--visual is only supported with /usage report.";
		await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: false, error }, null, 2) : error, parsed.json);
		return;
	}

	if (parsed.visual && parsed.json) {
		const error = "--visual cannot be combined with --json.";
		await notifyOutput(ctx, JSON.stringify({ ok: false, error }, null, 2), parsed.json);
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

	if (parsed.selectBranch && !parsed.project) {
		const current = await getCurrentUsageProject(ctx);
		parsed.project = getProjectKeyFor(current.project, current.cwd);
	}

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

	if (parsed.mode === "project" && !parsed.project) {
		const projects = listProjects(records);
		if (!projects.length) {
			await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: false, error: "No usage records found.", projects, skippedLines }, null, 2) : "No usage records found.", parsed.json);
			return;
		}

		if (!ctx.hasUI) {
			const error = "Project selection requires an interactive UI. Use /usage project --list or /usage project <project> instead.";
			await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: false, error, projects, skippedLines }, null, 2) : error, parsed.json);
			return;
		}

		const selected = await ctx.ui.select("Select project usage to view:", projects);
		if (!selected) {
			await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: false, cancelled: true, projects, skippedLines }, null, 2) : "Project selection cancelled.", parsed.json);
			return;
		}
		parsed.project = selected;
	}

	if ((parsed.branch || parsed.selectBranch) && !parsed.project) {
		const error = "--branch requires --project or /usage project <project>.";
		await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: false, error, skippedLines }, null, 2) : error, parsed.json);
		return;
	}

	if (parsed.project && !records.some((record) => matchesProject(record, parsed.project!))) {
		const error = `No usage records found for project "${parsed.project}". Try /usage project --list.`;
		await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: false, error, projects: listProjects(records), skippedLines }, null, 2) : error, parsed.json);
		return;
	}

	if (parsed.selectBranch && !parsed.branch) {
		const cwd = getCwd(ctx);
		const branch = cwd ? await git(cwd, ["branch", "--show-current"]) : null;
		if (!branch) {
			const error = "Unable to determine the current git branch. Supply one with --branch <branch>.";
			await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: false, error, skippedLines }, null, 2) : error, parsed.json);
			return;
		}
		parsed.branch = branch;
	}

	if (parsed.branch && !records.some((record) => matchesProject(record, parsed.project!) && matchesBranch(record, parsed.branch!))) {
		const error = `No usage records found for branch "${parsed.branch}" in project "${parsed.project}".`;
		await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: false, error, skippedLines }, null, 2) : error, parsed.json);
		return;
	}

	if (parsed.model && !records.some((record) => matchesModel(record, parsed.model!))) {
		const error = `No usage records found for model "${parsed.model}". Try /usage model --list.`;
		await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: false, error, models: listModels(records), skippedLines }, null, 2) : error, parsed.json);
		return;
	}

	if (parsed.mode === "project" && parsed.project && !parsed.branch) {
		const report = buildProjectUsageReport(records, { project: parsed.project, skippedLines });
		await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: true, report }, null, 2) : formatProjectUsageReport(records, { project: parsed.project, skippedLines }), parsed.json);
		return;
	}

	if (parsed.mode === "report") {
		const report = buildUsageReport(records, { range: parsed.range, project: parsed.project, model: parsed.model, branch: parsed.branch, skippedLines });
		const text = parsed.visual
			? formatVisualUsageReport(records, { range: parsed.range, project: parsed.project, model: parsed.model, branch: parsed.branch, skippedLines })
			: formatUsageReport(records, { range: parsed.range, project: parsed.project, model: parsed.model, branch: parsed.branch, skippedLines });
		await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: true, report }, null, 2) : text, parsed.json);
		return;
	}

	const summary = summarizeRecords(records, { range: parsed.range, project: parsed.project, model: parsed.model, branch: parsed.branch, skippedLines });
	const tags = parsed.project || parsed.branch
		? tagBreakdown(filterRecords(records, { range: parsed.range, project: parsed.project, model: parsed.model, branch: parsed.branch }))
		: [];
	await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: true, summary: { ...summary, ...(tags.length ? { tags } : {}) } }, null, 2) : formatSummary(summary, tags), parsed.json);
}

export default function (pi: ExtensionAPI) {
	let usageSession: UsageSessionState | undefined;
	type CodexRefreshOutcome = { ok: boolean; error?: string; limits?: CodexUsageLimits };
	let codexLimitsRefresh: Promise<CodexRefreshOutcome> | undefined;
	let codexLimitsAbort: AbortController | undefined;
	let codexLimitsGeneration = 0;

	const refreshCodexLimits = async (ctx: ExtensionContext): Promise<CodexRefreshOutcome> => {
		if (codexLimitsRefresh) return codexLimitsRefresh;
		const controller = new AbortController();
		const generation = codexLimitsGeneration;
		codexLimitsAbort = controller;
		const task = (async (): Promise<CodexRefreshOutcome> => {
			try {
				const accessToken = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
				if (controller.signal.aborted || generation !== codexLimitsGeneration) return { ok: false, error: "OpenAI usage request was cancelled" };
				if (!accessToken) throw new Error("Sign in to the openai-codex provider first");
				const limits = await fetchCodexUsageLimits(accessToken, { signal: controller.signal });
				if (controller.signal.aborted || generation !== codexLimitsGeneration) return { ok: false, error: "OpenAI usage request was cancelled" };
				return { ok: true, limits };
			} catch (error: any) {
				return { ok: false, error: error?.message ?? "Unable to retrieve OpenAI usage limits" };
			} finally {
				if (codexLimitsAbort === controller) {
					codexLimitsAbort = undefined;
					codexLimitsRefresh = undefined;
				}
			}
		})();
		codexLimitsRefresh = task;
		return task;
	};

	const handleCodexLimitsCommand = async (args: string, ctx: ExtensionContext): Promise<boolean> => {
		const tokens = tokenizeArgs(args);
		if (tokens[0] !== "openai") return false;
		const rest = tokens.slice(1);
		const json = rest.includes("--json");
		if (rest.some((token) => token !== "--json") || rest.filter((token) => token === "--json").length > 1) {
			const error = "Usage: /usage openai [--json]";
			await notifyOutput(ctx, json ? JSON.stringify({ ok: false, error }, null, 2) : error, json);
			return true;
		}
		const generation = codexLimitsGeneration;
		const outcome = await refreshCodexLimits(ctx);
		if (generation !== codexLimitsGeneration) return true;
		if (!outcome.ok) {
			const error = outcome.error ?? "OpenAI Codex subscription limits are unavailable";
			await notifyOutput(ctx, json ? JSON.stringify({ ok: false, error }, null, 2) : error, json);
			return true;
		}
		await notifyOutput(
			ctx,
			json ? JSON.stringify({ ok: true, limits: outcome.limits }, null, 2) : formatCodexUsageLimits(outcome.limits!),
			json,
		);
		return true;
	};

	const legacyTags = (ctx: ExtensionContext): string[] => {
		let tags: string[] = [];
		for (const entry of ctx.sessionManager.getBranch() as SessionEntry[]) {
			if (entry.type !== "custom" || entry.customType !== legacyUsageTagCustomType) continue;
			const state = entry.data as { version?: unknown; tags?: unknown } | undefined;
			if (state?.version === 1 && Array.isArray(state.tags) && state.tags.every((tag) => typeof tag === "string")) tags = normalizeUsageTags(state.tags);
		}
		return tags;
	};

	const initializeUsageSession = async (ctx: ExtensionContext): Promise<UsageSessionState> => {
		const existing = getUsageSessionState(ctx.sessionManager.getBranch());
		if (existing) return usageSession = existing;

		const cwd = getCwd(ctx);
		let project: ProjectInfo = { name: null, gitRemote: null, gitRoot: null, gitCommonDir: null, gitBranch: null };
		let config: UsageConfig | null = null;
		if (cwd) {
			project = await getProjectInfo(cwd);
			try {
				config = await readUsageConfig(cwd);
				project = applyProjectAttributionOverride(project, cwd, config);
			} catch (error: any) {
				console.warn(`Usage tracker ignored local usage config: ${error?.message ?? String(error)}`);
			}
		}
		usageSession = {
			version: 1,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile?.() ?? null,
			cwd,
			project,
			tags: normalizeUsageTags([...(config?.tags ?? []), ...legacyTags(ctx), ...getInheritedUsageTags()]),
		};
		pi.appendEntry(usageSessionCustomType, usageSession);
		return usageSession;
	};

	const updateTags = (ctx: ExtensionContext, tags: string[]): UsageSessionState => {
		const current = usageSession ?? {
			version: 1 as const,
			sessionId: ctx.sessionManager.getSessionId?.() ?? "unknown",
			sessionFile: ctx.sessionManager.getSessionFile?.() ?? null,
			cwd: getCwd(ctx),
			project: { name: null, gitRemote: null, gitRoot: null, gitCommonDir: null, gitBranch: null },
			tags: [],
		};
		usageSession = { ...current, tags: normalizeUsageTags(tags) };
		pi.appendEntry(usageSessionCustomType, usageSession);
		return usageSession;
	};

	const handleTagCommand = async (parsed: ParsedUsageCommand, ctx: ExtensionContext): Promise<void> => {
		if (parsed.error) {
			ctx.ui.notify(parsed.error, "error");
			return;
		}
		const activeTags = usageSession?.tags ?? [];
		if (parsed.list) {
			const result = { ok: true, tags: activeTags };
			await notifyOutput(ctx, parsed.json ? JSON.stringify(result, null, 2) : formatTags(activeTags), parsed.json);
			return;
		}
		if (parsed.tagClear) {
			updateTags(ctx, []);
			await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: true, tags: [] }, null, 2) : "Cleared active usage tags.", parsed.json);
			return;
		}
		if (parsed.tagRemove) {
			const remaining = activeTags.filter((tag) => tag !== parsed.tagRemove);
			if (remaining.length === activeTags.length) {
				await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: false, error: `Tag not active: ${parsed.tagRemove}` }, null, 2) : `Tag not active: ${parsed.tagRemove}`, parsed.json);
				return;
			}
			const state = updateTags(ctx, remaining);
			await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: true, tags: state.tags }, null, 2) : formatTags(state.tags), parsed.json);
			return;
		}
		const state = updateTags(ctx, [...activeTags, ...(parsed.tags ?? [])]);
		await notifyOutput(ctx, parsed.json ? JSON.stringify({ ok: true, tags: state.tags }, null, 2) : formatTags(state.tags), parsed.json);
	};

	pi.on("session_start", async (_event, ctx) => {
		await initializeUsageSession(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await initializeUsageSession(ctx);
	});

	pi.on("session_shutdown", async () => {
		codexLimitsGeneration += 1;
		codexLimitsAbort?.abort();
		codexLimitsAbort = undefined;
		codexLimitsRefresh = undefined;
	});

	pi.on("message_end", async (event, ctx) => {
		// Only assistant responses have provider usage. Tool results and user messages
		// are ignored; additional assistant turns caused by tool calls are counted if
		// Pi emits usage for them.
		if (event.message.role !== "assistant") return;
		if (!event.message.usage) return;

		const record = buildRecord(ctx, event.message, await initializeUsageSession(ctx));
		// Protect against duplicate event delivery within this process. Cross-process
		// dedupe is intentionally deferred unless/until we move to SQLite.
		if (seenRecordIds.has(record.id)) return;
		await appendLedgerRecord(record);
		seenRecordIds.add(record.id);
	});

	pi.registerCommand("usage", {
		description: "Show cross-session token usage and estimated spending",
		handler: async (args, ctx) => {
			try {
				if (await handleCodexLimitsCommand(args, ctx)) return;
				const parsed = parseUsageArgs(args);
				if (parsed.mode === "tag" || (parsed.error && tokenizeArgs(args)[0] === "tag")) {
					await handleTagCommand(parsed, ctx);
					return;
				}
				await handleUsageCommand(args, ctx);
			} catch (error: any) {
				ctx.ui.notify(`Usage ledger error: ${error?.message ?? String(error)}`, "error");
			}
		},
	});
}
