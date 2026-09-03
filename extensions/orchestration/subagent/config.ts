import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];

export type SubagentModelConfig = {
    model?: string;
    thinking?: ThinkingLevel;
};

export type SubagentsConfig = {
    defaults?: SubagentModelConfig;
    agents?: Record<string, SubagentModelConfig>;
};

type SettingsFile = {
    subagents?: SubagentsConfig;
};

export type ResolvedSubagentConfig = Required<SubagentModelConfig>;

function isThinkingLevel(value: unknown): value is ThinkingLevel {
    return typeof value === "string" && (thinkingLevels as readonly string[]).includes(value);
}

function parseModelConfig(value: unknown): SubagentModelConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const candidate = value as Record<string, unknown>;
    return {
        ...(typeof candidate.model === "string" && candidate.model.trim() ? { model: candidate.model.trim() } : {}),
        ...(isThinkingLevel(candidate.thinking) ? { thinking: candidate.thinking } : {}),
    };
}

function parseSubagentsConfig(value: unknown): SubagentsConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const candidate = value as Record<string, unknown>;
    const agents = candidate.agents;
    const parsedAgents: Record<string, SubagentModelConfig> = {};
    if (agents && typeof agents === "object" && !Array.isArray(agents)) {
        for (const [name, config] of Object.entries(agents)) parsedAgents[name] = parseModelConfig(config);
    }
    return { defaults: parseModelConfig(candidate.defaults), agents: parsedAgents };
}

function readSettings(filePath: string): SubagentsConfig {
    try {
        if (!existsSync(filePath)) return {};
        const settings = JSON.parse(readFileSync(filePath, "utf8")) as SettingsFile;
        return parseSubagentsConfig(settings.subagents);
    } catch {
        return {};
    }
}

/** Resolves a role's configuration without reading the filesystem; useful for tests. */
export function resolveSubagentConfig(
    agent: string,
    builtIn: ResolvedSubagentConfig,
    globalConfig: SubagentsConfig = {},
    projectConfig: SubagentsConfig = {},
): ResolvedSubagentConfig {
    return {
        ...builtIn,
        ...globalConfig.defaults,
        ...globalConfig.agents?.[agent],
        ...projectConfig.defaults,
        ...projectConfig.agents?.[agent],
    };
}

/** Project settings override global settings, field-by-field, for each role. */
export function loadSubagentConfig(cwd: string, agent: string, builtIn: ResolvedSubagentConfig): ResolvedSubagentConfig {
    const globalConfig = readSettings(path.join(getAgentDir(), "settings.json"));
    const projectConfig = readSettings(path.join(cwd, ".pi", "settings.json"));
    return resolveSubagentConfig(agent, builtIn, globalConfig, projectConfig);
}
