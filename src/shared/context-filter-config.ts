import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { detectProject } from "./project-detection.ts";

export const contextFilterChangedEvent = "pise-en-place:context-filter-changed";

export type ContextFilterScope = "project" | "paths";
export type SkillFilterScope = "names";

export type SkillRule = {
	enabled?: boolean;
	scope?: SkillFilterScope;
	ignore?: string[];
};

export type ProjectRule = {
	enabled?: boolean;
	scope?: ContextFilterScope;
	ignore?: string[];
	skills?: SkillRule;
};

export type ContextFileFilterConfig = {
	enabled?: boolean;
	projects?: Record<string, ProjectRule>;
};

type SettingsWithContextFilter = Record<string, unknown> & {
	contextFileFilter?: ContextFileFilterConfig;
};

function readJsonFile(filePath: string): SettingsWithContextFilter {
	if (!existsSync(filePath)) return {};
	const parsed = JSON.parse(readFileSync(filePath, "utf8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${filePath} must contain a JSON object.`);
	}
	return parsed as SettingsWithContextFilter;
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

function readJsonFileOrEmpty(filePath: string): SettingsWithContextFilter {
	try {
		return readJsonFile(filePath);
	} catch {
		return {};
	}
}

export function loadContextFilterConfig(cwd: string, agentDir = getAgentDir()): ContextFileFilterConfig | undefined {
	const globalSettings = readJsonFileOrEmpty(path.join(agentDir, "settings.json"));
	const projectSettings = readJsonFileOrEmpty(path.join(cwd, ".pi", "settings.json"));
	return mergeConfig(globalSettings.contextFileFilter, projectSettings.contextFileFilter);
}

export type DisabledProjectSkills = {
	projectId?: string;
	enabled: boolean;
	skills: string[];
	reason?: string;
};

export function getDisabledProjectSkills(cwd: string, agentDir = getAgentDir()): DisabledProjectSkills {
	const project = detectProject(cwd);
	if (!project.id) return { enabled: false, skills: [], reason: project.error ?? "project ID unavailable" };

	const config = loadContextFilterConfig(cwd, agentDir);
	if (!config) return { projectId: project.id, enabled: false, skills: [], reason: "context filter is not configured" };
	if (config.enabled === false) return { projectId: project.id, enabled: false, skills: [], reason: "context filter is disabled" };

	const rule = config.projects?.[project.id];
	if (!rule) return { projectId: project.id, enabled: false, skills: [], reason: "project rule is not configured" };
	if (rule.enabled === false || rule.skills?.enabled === false) {
		return { projectId: project.id, enabled: false, skills: [], reason: "project skill filter is disabled" };
	}

	return {
		projectId: project.id,
		enabled: true,
		skills: Array.from(new Set(rule.skills?.ignore ?? [])).sort((left, right) => left.localeCompare(right)),
	};
}

export function saveContextFilterProjectRule(projectId: string, rule: ProjectRule, agentDir = getAgentDir()): void {
	const settingsPath = path.join(agentDir, "settings.json");
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

export function disableProjectSkill(projectId: string, skillName: string, cwd: string, agentDir = getAgentDir()): { alreadyDisabled: boolean; rule: ProjectRule } {
	const settingsPath = path.join(agentDir, "settings.json");
	const settings = readJsonFile(settingsPath);
	const currentFilter = settings.contextFileFilter ?? {};
	const currentRule = currentFilter.projects?.[projectId] ?? {};
	const projectSettings = readJsonFileOrEmpty(path.join(cwd, ".pi", "settings.json"));
	const projectFilter = projectSettings.contextFileFilter;
	const projectRule = projectFilter?.projects?.[projectId];

	const effectiveFilterEnabled = projectFilter?.enabled ?? currentFilter.enabled ?? true;
	if (!effectiveFilterEnabled || projectRule?.enabled === false || projectRule?.skills?.enabled === false) {
		throw new Error("The context filter is disabled. Enable it before disabling a skill.");
	}
	if (projectRule) {
		if (projectRule.skills?.ignore?.includes(skillName)) return { alreadyDisabled: true, rule: projectRule };
		throw new Error("A project-local .pi/settings.json rule overrides the user-level context filter. Update that project rule instead.");
	}
	if (currentRule.enabled === false || currentRule.skills?.enabled === false) {
		throw new Error("The context filter is disabled. Enable it with /context project config before disabling a skill.");
	}

	const ignoredSkills = currentRule.skills?.ignore ?? [];
	const alreadyDisabled = ignoredSkills.includes(skillName);
	const rule: ProjectRule = {
		...currentRule,
		enabled: true,
		scope: currentRule.scope ?? "paths",
		ignore: currentRule.ignore ?? [],
		skills: {
			...currentRule.skills,
			enabled: true,
			scope: "names",
			ignore: Array.from(new Set([...ignoredSkills, skillName])).sort((left, right) => left.localeCompare(right)),
		},
	};

	settings.contextFileFilter = {
		...currentFilter,
		enabled: currentFilter.enabled ?? true,
		projects: {
			...(currentFilter.projects ?? {}),
			[projectId]: rule,
		},
	};
	writeJsonFile(settingsPath, settings);
	return { alreadyDisabled, rule };
}
