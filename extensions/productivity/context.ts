/*
 * Context file filter extension.
 *
 * Adds /context for reporting the active context-file filter state and filters
 * configured project context files out of the prompt sent to the model.
 *
 * Important implementation note: normal Pi extensions can inspect loaded context
 * files during before_agent_start, but they cannot currently mutate Pi's loaded
 * context-file list or loaded skill list. This extension therefore removes
 * matching <project_instructions> and <skill> blocks from the assembled system
 * prompt on each agent run. Pi still discovers the resources normally, and the
 * startup header may still list them. A true load-time filter would require an
 * SDK wrapper using agentsFilesOverride or a Pi core context/skill filter hook.
 *
 * Configuration lives in Pi settings under contextFileFilter. Rules are keyed by
 * normalized Git project ID, e.g. github.com:owner/repo.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { askQuestionnaire } from "../../src/shared/interactive-questions.ts";
import { expandHome, detectProject, type ProjectInfo } from "../../src/shared/project-detection.ts";

const commandName = "context";
const noContextFilesValue = "__context-filter-none-files__";
const noSkillsValue = "__context-filter-none-skills__";

type ContextFilterScope = "project" | "paths";
type SkillFilterScope = "names";

type SkillRule = {
	enabled?: boolean;
	scope?: SkillFilterScope;
	ignore?: string[];
};

type ProjectRule = {
	enabled?: boolean;
	scope?: ContextFilterScope;
	ignore?: string[];
	skills?: SkillRule;
};

type ContextFileFilterConfig = {
	enabled?: boolean;
	projects?: Record<string, ProjectRule>;
};

type SettingsWithContextFilter = Record<string, unknown> & {
	contextFileFilter?: ContextFileFilterConfig;
};

type ContextConfigAnswer = "enabled" | "disabled" | string;



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

type SkillInfo = {
	name: string;
};


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




function resolveState(cwd: string): ActiveRuleState {
	const project = detectProject(cwd);
	const config = loadConfig(cwd);

	if (!config) return { project, active: false, reason: "contextFileFilter is not configured" };
	if (config.enabled === false) return { project, config, active: false, reason: "contextFileFilter.enabled is false" };
	if (!project.id) return { project, config, active: false, reason: project.error ?? "project ID unavailable" };

	const rule = config.projects?.[project.id];
	if (!rule) return { project, config, active: false, reason: `no rule configured for ${project.id}` };
	if (rule.enabled === false) return { project, config, rule, active: false, reason: "project rule is disabled" };

	const hasContextIgnores = (rule.ignore?.length ?? 0) > 0;
	const hasSkillIgnores = rule.skills?.enabled !== false && (rule.skills?.ignore?.length ?? 0) > 0;
	if (!hasContextIgnores && !hasSkillIgnores) return { project, config, rule, active: false, reason: "project rule has no ignore entries" };

	return { project, config, rule, active: true };
}

type PrivateGuidanceState = {
	active: boolean;
	key?: string;
	path?: string;
	error?: string;
};

function resolvePrivateGuidance(projectId: string | undefined): PrivateGuidanceState {
	if (!projectId) return { active: false };

	const configPath = path.join(getAgentDir(), "projects.json");
	try {
		if (!existsSync(configPath)) return { active: false };
		const parsed = JSON.parse(readFileSync(configPath, "utf8"));

		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { active: false, error: "projects.json must be a top-level object" };
		}

		const projectConfig = parsed[projectId];
		if (projectConfig === undefined) return { active: false };

		if (projectConfig === null || typeof projectConfig !== "object" || Array.isArray(projectConfig)) {
			return { active: false, key: projectId, error: `entry for ${projectId} must be an object` };
		}

		const guidance = projectConfig.additional_guidance;
		if (guidance === undefined) return { active: false };

		if (typeof guidance !== "string" || guidance.trim() === "") {
			return { active: false, key: projectId, error: `additional_guidance for ${projectId} must be a non-empty string path` };
		}

		const guidancePath = guidance.trim();
		const expandedPath = expandHome(guidancePath);
		return { active: true, key: projectId, path: expandedPath };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { active: false, error: `failed to read projects.json: ${message}` };
	}
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

function shouldIgnoreSkill(skill: SkillInfo, state: ActiveRuleState): boolean {
	if (!state.active || state.rule?.skills?.enabled === false) return false;
	const skillRule = state.rule?.skills;
	if (!skillRule?.ignore?.length) return false;
	return (skillRule.scope ?? "names") === "names" && skillRule.ignore.includes(skill.name);
}

function removeSkillBlocks(systemPrompt: string, ignored: SkillInfo[]): string {
	let nextPrompt = systemPrompt;
	for (const skill of ignored) {
		const skillBlockPattern = new RegExp(`\\n?\\s*<skill>\\s*\\n\\s*<name>${escapeRegExp(skill.name)}</name>[\\s\\S]*?\\n\\s*</skill>`, "g");
		nextPrompt = nextPrompt.replace(skillBlockPattern, "");
	}

	return nextPrompt.replace(
		/\n\nThe following skills provide specialized instructions for specific tasks\.\nUse the read tool to load a skill's file when the task matches its description\.\nWhen a skill file references a relative path, resolve it against the skill directory \(parent of SKILL\.md \/ dirname of the path\) and use that absolute path in tool commands\.\n\n<available_skills>\s*<\/available_skills>\n/,
		"\n"
	);
}

function extractContextPaths(systemPrompt: string): string[] {
	return [...systemPrompt.matchAll(/<project_instructions path="([^"]+)">/g)].map((match) => match[1]);
}

function extractSkillNames(systemPrompt: string): string[] {
	return Array.from(new Set([...systemPrompt.matchAll(/<skill>\s*<name>([^<]+)<\/name>/g)].map((match) => match[1]))).sort((a, b) => a.localeCompare(b));
}

function formatList(items: string[], emptyText: string): string[] {
	if (!items.length) return [emptyText];
	return items.map((item) => `- ${item}`);
}

function formatStatus(state: ActiveRuleState, cwd: string, lastLoadedPaths: string[], ignoredThisSession: string[], ignoredSkillsThisSession: string[], privateGuidanceState: PrivateGuidanceState): string {
	const lines = ["Context filter", ""];
	lines.push(`Project: ${state.project.id ?? "unknown"}`);
	if (state.project.gitRoot) lines.push(`Git root: ${state.project.gitRoot}`);
	if (state.project.remoteUrl) lines.push(`Remote: ${state.project.remoteUrl}`);
	lines.push(`Mode: ${state.active ? "active" : "inactive"}`);
	if (state.reason) lines.push(`Reason: ${state.reason}`);

	if (state.rule) {
		lines.push("Context files:");
		lines.push(`Scope: ${state.rule.scope ?? "project"}`);
		lines.push("Ignore rules:");
		lines.push(...formatList(state.rule.ignore ?? [], "- (none)"));

		if (state.rule.skills) {
			lines.push("", "Skills:");
			lines.push(`State: ${state.rule.skills.enabled === false ? "disabled" : "enabled"}`);
			lines.push(`Scope: ${state.rule.skills.scope ?? "names"}`);
			lines.push("Ignore rules:");
			lines.push(...formatList(state.rule.skills.ignore ?? [], "- (none)"));
		}
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

	lines.push("", "Ignored context files this session:");
	lines.push(...formatList(ignoredThisSession, "- (none yet)"));
	lines.push("", "Ignored skills this session:");
	lines.push(...formatList(ignoredSkillsThisSession, "- (none yet)"));

	lines.push("", "Private guidance:");
	if (privateGuidanceState.active) {
		lines.push(`Key: ${privateGuidanceState.key}`);
		lines.push(`File: ${privateGuidanceState.path}`);
	} else if (privateGuidanceState.error) {
		lines.push(`Error: ${privateGuidanceState.error}`);
	} else {
		lines.push("Inactive: no additional_guidance configured for this project");
	}

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

function saveProjectRule(projectId: string, rule: ProjectRule): void {
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

function formatConfigSummary(projectId: string, rule: ProjectRule): string {
	return [
		`Updated context filter for ${projectId}.`,
		"",
		`State: ${rule.enabled !== false ? "enabled" : "disabled"}`,
		"Context files:",
		`Scope: ${rule.scope ?? "paths"}`,
		"Ignore rules:",
		...formatList(rule.ignore ?? [], "- (none)"),
		"",
		"Skills:",
		`Scope: ${rule.skills?.scope ?? "names"}`,
		"Ignore rules:",
		...formatList(rule.skills?.ignore ?? [], "- (none)"),
	].join("\n");
}

export default function contextExtension(pi: ExtensionAPI) {
	let state: ActiveRuleState | undefined;
	let lastLoadedPaths: string[] = [];
	let ignoredThisSession: string[] = [];
	let ignoredSkillsThisSession: string[] = [];
	const notifiedIgnoredSets = new Set<string>();
	const notifiedIgnoredSkillSets = new Set<string>();
	let privateGuidanceState: PrivateGuidanceState = { active: false };
	const privateGuidanceNotifiedPaths = new Set<string>();
	const notifiedGuidanceErrors = new Set<string>();

	function refreshState(cwd: string): ActiveRuleState {
		state = resolveState(cwd);
		return state;
	}

	pi.on("session_start", async (_event, ctx) => {
		refreshState(ctx.cwd);
		lastLoadedPaths = [];
		ignoredThisSession = [];
		ignoredSkillsThisSession = [];
		notifiedIgnoredSets.clear();
		notifiedIgnoredSkillSets.clear();
		privateGuidanceState = { active: false };
		privateGuidanceNotifiedPaths.clear();
		notifiedGuidanceErrors.clear();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const currentState = state ?? refreshState(ctx.cwd);
		const contextFiles = event.systemPromptOptions.contextFiles ?? [];
		const skills = event.systemPromptOptions.skills ?? [];
		lastLoadedPaths = contextFiles.map((file) => file.path);

		const ignored = contextFiles.filter((file) => shouldIgnoreContextFile(file, ctx.cwd, currentState));
		const ignoredSkills = skills.filter((skill) => shouldIgnoreSkill(skill, currentState));

		let systemPrompt = event.systemPrompt;
		let modified = false;

		if (ignored.length) {
			ignoredThisSession = Array.from(new Set([...ignoredThisSession, ...ignored.map((file) => file.path)])).sort();
			systemPrompt = removeContextBlocks(systemPrompt, ignored);
			modified = true;

			if (ctx.hasUI) {
				const key = ignored.map((file) => file.path).sort().join("\n");
				if (!notifiedIgnoredSets.has(key)) {
					notifiedIgnoredSets.add(key);
					ctx.ui.notify(["Ignored context files:", ...ignored.map((file) => `- ${file.path}`)].join("\n"), "info");
				}
			}
		}

		if (ignoredSkills.length) {
			ignoredSkillsThisSession = Array.from(new Set([...ignoredSkillsThisSession, ...ignoredSkills.map((skill) => skill.name)])).sort();
			systemPrompt = removeSkillBlocks(systemPrompt, ignoredSkills);
			modified = true;

			if (ctx.hasUI) {
				const key = ignoredSkills.map((skill) => skill.name).sort().join("\n");
				if (!notifiedIgnoredSkillSets.has(key)) {
					notifiedIgnoredSkillSets.add(key);
					ctx.ui.notify(["Ignored skills:", ...ignoredSkills.map((skill) => `- ${skill.name}`)].join("\n"), "info");
				}
			}
		}

		privateGuidanceState = resolvePrivateGuidance(currentState.project.id);

		if (privateGuidanceState.error && !privateGuidanceState.active) {
			const errorKey = `${privateGuidanceState.key ?? "unknown"}:${privateGuidanceState.path ?? "none"}:${privateGuidanceState.error}`;
			if (ctx.hasUI && !notifiedGuidanceErrors.has(errorKey)) {
				notifiedGuidanceErrors.add(errorKey);
				ctx.ui.notify(`Private guidance configuration error: ${privateGuidanceState.error}`, "error");
			}
		}

		if (privateGuidanceState.active && privateGuidanceState.path) {
			try {
				const content = readFileSync(privateGuidanceState.path, "utf8");
				const guidanceBlock = `<project_instructions path="${privateGuidanceState.path}">\n${content}\n</project_instructions>`;
				if (/<\/project_context>/.test(systemPrompt)) {
					systemPrompt = systemPrompt.replace(/(\n?\s*<\/project_context>)/, `\n${guidanceBlock}\n$1`);
				} else {
					const projectContextBlock = `<project_context>\n\nProject-specific instructions and guidelines:\n\n${guidanceBlock}\n\n</project_context>`;
					if (/\n\nThe following skills provide specialized instructions/.test(systemPrompt)) {
						systemPrompt = systemPrompt.replace(/\n\nThe following skills provide specialized instructions/, `\n\n${projectContextBlock}\n\nThe following skills provide specialized instructions`);
					} else if (/\nCurrent working directory:/.test(systemPrompt)) {
						systemPrompt = systemPrompt.replace(/\nCurrent working directory:/, `\n\n${projectContextBlock}\nCurrent working directory:`);
					} else {
						systemPrompt = systemPrompt + "\n\n" + projectContextBlock;
					}
				}
				modified = true;
				if (ctx.hasUI && !privateGuidanceNotifiedPaths.has(privateGuidanceState.path)) {
					privateGuidanceNotifiedPaths.add(privateGuidanceState.path);
					ctx.ui.notify(`Private project guidance loaded from ${privateGuidanceState.path}`, "info");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				privateGuidanceState = { ...privateGuidanceState, error: message };
				const errorKey = `${privateGuidanceState.key ?? "unknown"}:${privateGuidanceState.path ?? "none"}:${message}`;
				if (ctx.hasUI && !notifiedGuidanceErrors.has(errorKey)) {
					notifiedGuidanceErrors.add(errorKey);
					ctx.ui.notify(`Failed to load private guidance: ${message}`, "error");
				}
			}
		}

		if (!modified) return;
		return { systemPrompt };
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
				const configuredSkillIgnore = existingRule?.skills?.ignore ?? [];
				const candidates = discoverContextCandidates(ctx.cwd);
				const options = mergeCandidateAndConfiguredPaths(candidates, configuredIgnore);
				const skillCandidates = extractSkillNames(ctx.getSystemPrompt());
				const skillOptions = mergeCandidateAndConfiguredPaths(skillCandidates, configuredSkillIgnore);

				const answers = await askQuestionnaire<ContextConfigAnswer>(ctx, {
					title: `Configure context filter for ${currentState.project.id}`,
					questions: [
						{
							id: "enabled",
							label: "State",
							question: "Should context filtering be enabled for this project?",
							multiple: false,
							options: [
								{ label: "Enabled", value: "enabled", selected: existingRule?.enabled !== false, description: "Apply this project's ignore list before each agent run." },
								{ label: "Disabled", value: "disabled", selected: existingRule?.enabled === false, description: "Keep this project's rule but do not filter context files." },
							],
						},
						{
							id: "ignore",
							label: "Files",
							question: "Which context files should be ignored?",
							multiple: true,
							options: [
								{ label: "(none)", value: noContextFilesValue, selected: configuredIgnore.length === 0 },
								...options.map((relativePath) => ({
									label: relativePath,
									value: relativePath,
									selected: configuredIgnore.includes(relativePath),
									description: candidates.includes(relativePath) ? undefined : "Configured but not found under the current directory.",
								})),
							],
						},
						{
							id: "skills",
							label: "Skills",
							question: "Which skills should be hidden from the model for this project?",
							multiple: true,
							options: [
								{ label: "(none)", value: noSkillsValue, selected: configuredSkillIgnore.length === 0 },
								...skillOptions.map((skillName) => ({
									label: skillName,
									value: skillName,
									selected: configuredSkillIgnore.includes(skillName),
									description: skillCandidates.includes(skillName) ? undefined : "Configured but not currently loaded.",
								})),
							],
						},
					],
				});

				if (!answers.length) {
					ctx.ui.notify("Context project config cancelled.", "info");
					return;
				}

				const enabledAnswer = answers.find((answer) => answer.id === "enabled")?.selected[0];
				const ignoreAnswers = answers.find((answer) => answer.id === "ignore")?.selected ?? [];
				const skillAnswers = answers.find((answer) => answer.id === "skills")?.selected ?? [];
				const rule: ProjectRule = {
					enabled: enabledAnswer !== "disabled",
					scope: "paths",
					ignore: ignoreAnswers
						.filter((value): value is string => typeof value === "string" && value !== noContextFilesValue)
						.sort((a, b) => a.localeCompare(b)),
					skills: {
						enabled: true,
						scope: "names",
						ignore: skillAnswers
							.filter((value): value is string => typeof value === "string" && value !== noSkillsValue)
							.sort((a, b) => a.localeCompare(b)),
					},
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
			privateGuidanceState = resolvePrivateGuidance(currentState.project.id);
			const promptPaths = extractContextPaths(ctx.getSystemPrompt());
			const visibleLoadedPaths = lastLoadedPaths.length ? lastLoadedPaths : promptPaths;
			ctx.ui.notify(formatStatus(currentState, ctx.cwd, visibleLoadedPaths, ignoredThisSession, ignoredSkillsThisSession, privateGuidanceState), "info");
		},
	});
}
