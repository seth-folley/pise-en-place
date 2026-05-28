/*
 * Context file filter extension.
 *
 * Adds /context for reporting the active context-file filter state and filters
 * configured project context files out of the prompt sent to the model.
 *
 * Important implementation note: normal Pi extensions can inspect loaded context
 * files during before_agent_start, but they cannot currently mutate Pi's loaded
 * context-file list. This extension therefore removes matching
 * <project_instructions> blocks from the assembled system prompt on each agent
 * run. Pi still discovers the files normally, and the startup header may still
 * list them. A true load-time filter would require an SDK wrapper using
 * agentsFilesOverride or a Pi core context-file filter hook.
 *
 * Configuration lives in Pi settings under contextFileFilter. Rules are keyed by
 * normalized Git project ID, e.g. github.com:owner/repo.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { askQuestionnaire } from "../../src/shared/interactive-questions.ts";

const commandName = "context";

type ContextFilterScope = "project" | "paths";

type ProjectRule = {
	enabled?: boolean;
	scope?: ContextFilterScope;
	ignore?: string[];
};

type ContextFileFilterConfig = {
	enabled?: boolean;
	projects?: Record<string, ProjectRule>;
};

type SettingsWithContextFilter = Record<string, unknown> & {
	contextFileFilter?: ContextFileFilterConfig;
};

type ContextConfigAnswer = "enabled" | "disabled" | string;

type ProjectInfo = {
	id?: string;
	gitRoot?: string;
	remoteUrl?: string;
	error?: string;
};

type ActiveRuleState = {
	project: ProjectInfo;
	config?: ContextFileFilterConfig;
	rule?: ProjectRule;
	active: boolean;
	reason?: string;
};

type ContextFile = {
	path: string;
	content: string;
};

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

function readJsonFile(filePath: string): SettingsWithContextFilter {
	try {
		if (!existsSync(filePath)) return {};
		const parsed = JSON.parse(readFileSync(filePath, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as SettingsWithContextFilter : {};
	} catch {
		return {};
	}
}

function writeJsonFile(filePath: string, value: SettingsWithContextFilter): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function mergeConfig(globalConfig?: ContextFileFilterConfig, projectConfig?: ContextFileFilterConfig): ContextFileFilterConfig | undefined {
	if (!globalConfig && !projectConfig) return undefined;
	return {
		...globalConfig,
		...projectConfig,
		projects: {
			...(globalConfig?.projects ?? {}),
			...(projectConfig?.projects ?? {}),
		},
	};
}

function loadConfig(cwd: string): ContextFileFilterConfig | undefined {
	const globalSettings = readJsonFile(path.join(getAgentDir(), "settings.json"));
	const projectSettings = readJsonFile(path.join(cwd, ".pi", "settings.json"));
	return mergeConfig(globalSettings.contextFileFilter, projectSettings.contextFileFilter);
}

function git(args: string[], cwd: string): string | undefined {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
	} catch {
		return undefined;
	}
}

function normalizeRemoteUrl(remoteUrl: string): string | undefined {
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

function detectProject(cwd: string): ProjectInfo {
	const gitRoot = git(["rev-parse", "--show-toplevel"], cwd);
	if (!gitRoot) return { error: "not inside a Git worktree" };

	const remoteUrl = git(["config", "--get", "remote.origin.url"], gitRoot) ?? git(["remote", "get-url", "origin"], gitRoot);
	if (!remoteUrl) return { gitRoot, error: "Git remote origin is not configured" };

	const id = normalizeRemoteUrl(remoteUrl);
	if (!id) return { gitRoot, remoteUrl, error: "could not normalize Git remote origin URL" };

	return { id, gitRoot, remoteUrl };
}

function resolveState(cwd: string): ActiveRuleState {
	const project = detectProject(cwd);
	const config = loadConfig(cwd);

	if (!config) return { project, active: false, reason: "contextFileFilter is not configured" };
	if (config.enabled === false) return { project, config, active: false, reason: "contextFileFilter.enabled is false" };
	if (!project.id) return { project, config, active: false, reason: project.error ?? "project ID unavailable" };

	const rule = config.projects?.[project.id];
	if (!rule) return { project, config, active: false, reason: `no rule configured for ${project.id}` };
	if (rule.enabled === false) return { project, config, rule, active: false, reason: "project rule is disabled" };
	if (!rule.ignore?.length) return { project, config, rule, active: false, reason: "project rule has no ignore entries" };

	return { project, config, rule, active: true };
}

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}

function escapeRegExp(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
	const normalized = toPosixPath(pattern);
	let source = "";
	for (let i = 0; i < normalized.length; i += 1) {
		const char = normalized[i];
		const next = normalized[i + 1];
		const afterNext = normalized[i + 2];

		if (char === "*" && next === "*" && afterNext === "/") {
			source += "(?:.*/)?";
			i += 2;
			continue;
		}
		if (char === "*" && next === "*") {
			source += ".*";
			i += 1;
			continue;
		}
		if (char === "*") {
			source += "[^/]*";
			continue;
		}
		if (char === "?") {
			source += "[^/]";
			continue;
		}
		source += escapeRegExp(char);
	}
	return new RegExp(`^${source}$`);
}

function matchesPattern(pattern: string, relativePath: string, basename: string): boolean {
	const normalizedPattern = toPosixPath(pattern);
	if (!normalizedPattern.includes("/")) return globToRegExp(normalizedPattern).test(basename);
	return globToRegExp(normalizedPattern).test(relativePath);
}

function isInside(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isGlobalContextFile(filePath: string): boolean {
	return isInside(path.resolve(filePath), path.resolve(getAgentDir()));
}

function shouldIgnoreContextFile(file: Pick<ContextFile, "path">, cwd: string, state: ActiveRuleState): boolean {
	if (!state.active || !state.rule?.ignore?.length) return false;
	if (isGlobalContextFile(file.path)) return false;

	const filePath = path.resolve(file.path);
	const scope = state.rule.scope ?? "project";

	if (scope === "paths") {
		return state.rule.ignore.some((entry) => {
			const expanded = expandHome(entry);
			if (path.isAbsolute(expanded)) return false;
			const resolved = path.resolve(cwd, expanded);
			return filePath === resolved;
		});
	}

	const gitRoot = state.project.gitRoot;
	if (!gitRoot || !isInside(filePath, gitRoot)) return false;

	const relativePath = toPosixPath(path.relative(gitRoot, filePath));
	const basename = path.basename(filePath);
	return state.rule.ignore.some((entry) => matchesPattern(entry, relativePath, basename));
}

function removeContextBlocks(systemPrompt: string, ignored: ContextFile[]): string {
	let nextPrompt = systemPrompt;
	for (const file of ignored) {
		const block = `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
		nextPrompt = nextPrompt.split(block).join("");
	}

	return nextPrompt.replace(
		/\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n<\/project_context>\n/,
		"\n"
	);
}

function extractContextPaths(systemPrompt: string): string[] {
	return [...systemPrompt.matchAll(/<project_instructions path="([^"]+)">/g)].map((match) => match[1]);
}

function formatList(items: string[], emptyText: string): string[] {
	if (!items.length) return [emptyText];
	return items.map((item) => `- ${item}`);
}

function formatStatus(state: ActiveRuleState, cwd: string, lastLoadedPaths: string[], ignoredThisSession: string[]): string {
	const lines = ["Context filter", ""];
	lines.push(`Project: ${state.project.id ?? "unknown"}`);
	if (state.project.gitRoot) lines.push(`Git root: ${state.project.gitRoot}`);
	if (state.project.remoteUrl) lines.push(`Remote: ${state.project.remoteUrl}`);
	lines.push(`Mode: ${state.active ? "active" : "inactive"}`);
	if (state.reason) lines.push(`Reason: ${state.reason}`);

	if (state.rule) {
		lines.push(`Scope: ${state.rule.scope ?? "project"}`);
		lines.push("Ignore rules:");
		lines.push(...formatList(state.rule.ignore ?? [], "- (none)"));
	}

	const loadedPaths = lastLoadedPaths;
	if (loadedPaths.length) {
		const wouldIgnore = loadedPaths.filter((filePath) => shouldIgnoreContextFile({ path: filePath }, cwd, state));
		lines.push("", "Currently loaded context files:");
		lines.push(...formatList(loadedPaths, "- (none)"));
		lines.push("", "Matching ignored files:");
		lines.push(...formatList(wouldIgnore, "- (none)"));
	} else {
		lines.push("", "Currently loaded context files: not evaluated yet");
	}

	lines.push("", "Ignored this session:");
	lines.push(...formatList(ignoredThisSession, "- (none yet)"));

	return lines.join("\n");
}

function isContextCandidate(fileName: string): boolean {
	return /^(AGENTS|CLAUDE|CODEX)\.md$/i.test(fileName);
}

function discoverContextCandidates(cwd: string): string[] {
	const ignoredDirs = new Set([".git", ".pi", "node_modules", "dist", "build", "DerivedData"]);
	const candidates: string[] = [];

	function walk(directory: string): void {
		let entries;
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			const fullPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!ignoredDirs.has(entry.name)) walk(fullPath);
				continue;
			}

			if (entry.isFile() && isContextCandidate(entry.name)) {
				candidates.push(toPosixPath(path.relative(cwd, fullPath)));
			}
		}
	}

	walk(cwd);
	return candidates.sort((a, b) => a.localeCompare(b));
}

function mergeCandidateAndConfiguredPaths(candidates: string[], configured: string[]): string[] {
	return Array.from(new Set([...candidates, ...configured])).sort((a, b) => a.localeCompare(b));
}

function saveProjectRule(projectId: string, rule: Required<ProjectRule>): void {
	const settingsPath = path.join(getAgentDir(), "settings.json");
	const settings = readJsonFile(settingsPath);
	const currentFilter = settings.contextFileFilter ?? {};
	settings.contextFileFilter = {
		...currentFilter,
		enabled: currentFilter.enabled ?? true,
		projects: {
			...(currentFilter.projects ?? {}),
			[projectId]: rule,
		},
	};
	writeJsonFile(settingsPath, settings);
}

function formatConfigSummary(projectId: string, rule: Required<ProjectRule>): string {
	return [
		`Updated context filter for ${projectId}.`,
		"",
		`State: ${rule.enabled ? "enabled" : "disabled"}`,
		`Scope: ${rule.scope}`,
		"Ignored files:",
		...formatList(rule.ignore, "- (none)"),
	].join("\n");
}

export default function contextExtension(pi: ExtensionAPI) {
	let state: ActiveRuleState | undefined;
	let lastLoadedPaths: string[] = [];
	let ignoredThisSession: string[] = [];
	const notifiedIgnoredSets = new Set<string>();

	function refreshState(cwd: string): ActiveRuleState {
		state = resolveState(cwd);
		return state;
	}

	pi.on("session_start", async (_event, ctx) => {
		refreshState(ctx.cwd);
		lastLoadedPaths = [];
		ignoredThisSession = [];
		notifiedIgnoredSets.clear();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const currentState = state ?? refreshState(ctx.cwd);
		const contextFiles = event.systemPromptOptions.contextFiles ?? [];
		lastLoadedPaths = contextFiles.map((file) => file.path);

		const ignored = contextFiles.filter((file) => shouldIgnoreContextFile(file, ctx.cwd, currentState));
		if (!ignored.length) return;

		ignoredThisSession = Array.from(new Set([...ignoredThisSession, ...ignored.map((file) => file.path)])).sort();

		if (ctx.hasUI) {
			const key = ignored.map((file) => file.path).sort().join("\n");
			if (!notifiedIgnoredSets.has(key)) {
				notifiedIgnoredSets.add(key);
				ctx.ui.notify(["Ignored context files:", ...ignored.map((file) => `- ${file.path}`)].join("\n"), "info");
			}
		}

		return { systemPrompt: removeContextBlocks(event.systemPrompt, ignored) };
	});

	pi.registerCommand(commandName, {
		description: "Show or configure current context-file filter status",
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			if (trimmed === "project config") {
				if (!ctx.hasUI) {
					ctx.ui.notify("/context project config requires interactive UI.", "error");
					return;
				}

				const currentState = refreshState(ctx.cwd);
				if (!currentState.project.id) {
					ctx.ui.notify(`Cannot configure context filter: ${currentState.project.error ?? "project ID unavailable"}.`, "error");
					return;
				}

				const existingRule = currentState.rule;
				const configuredIgnore = existingRule?.ignore ?? [];
				const candidates = discoverContextCandidates(ctx.cwd);
				const options = mergeCandidateAndConfiguredPaths(candidates, configuredIgnore);

				if (!options.length) {
					ctx.ui.notify("No AGENTS.md, CLAUDE.md, or CODEX.md files found under the current directory, and no ignored files are currently configured.", "warning");
					return;
				}

				const answers = await askQuestionnaire<ContextConfigAnswer>(ctx, {
					title: `Configure context filter for ${currentState.project.id}`,
					questions: [
						{
							id: "enabled",
							label: "State",
							question: "Should context filtering be enabled for this project?",
							multiple: false,
							options: [
								{ label: "Enabled", value: "enabled", description: "Apply this project's ignore list before each agent run." },
								{ label: "Disabled", value: "disabled", description: "Keep this project's rule but do not filter context files." },
							],
						},
						{
							id: "ignore",
							label: "Files",
							question: "Which context files should be ignored?",
							multiple: true,
							options: options.map((relativePath) => ({
								label: relativePath,
								value: relativePath,
								selected: configuredIgnore.includes(relativePath),
								description: candidates.includes(relativePath) ? undefined : "Configured but not found under the current directory.",
							})),
						},
					],
				});

				if (!answers.length) {
					ctx.ui.notify("Context project config cancelled.", "info");
					return;
				}

				const enabledAnswer = answers.find((answer) => answer.id === "enabled")?.selected[0];
				const ignoreAnswers = answers.find((answer) => answer.id === "ignore")?.selected ?? [];
				const rule: Required<ProjectRule> = {
					enabled: enabledAnswer !== "disabled",
					scope: "paths",
					ignore: ignoreAnswers.filter((value): value is string => typeof value === "string").sort((a, b) => a.localeCompare(b)),
				};

				saveProjectRule(currentState.project.id, rule);
				refreshState(ctx.cwd);
				ctx.ui.notify(formatConfigSummary(currentState.project.id, rule), "info");
				return;
			}

			if (trimmed === "system-prompt") {
				ctx.ui.notify(ctx.getSystemPrompt(), "info");
				return;
			}

			if (trimmed && trimmed !== "status") {
				ctx.ui.notify("Usage: /context\n/context system-prompt\n/context project config", "info");
				return;
			}

			const currentState = refreshState(ctx.cwd);
			const promptPaths = extractContextPaths(ctx.getSystemPrompt());
			const visibleLoadedPaths = lastLoadedPaths.length ? lastLoadedPaths : promptPaths;
			ctx.ui.notify(formatStatus(currentState, ctx.cwd, visibleLoadedPaths, ignoredThisSession), "info");
		},
	});
}
