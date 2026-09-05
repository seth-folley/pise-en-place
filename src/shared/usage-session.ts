import { normalizeUsageTags } from "./usage-attribution.ts";

export const usageSessionCustomType = "usage-session";
export const inheritedUsageTagsEnvironmentVariable = "PISE_USAGE_INHERITED_TAGS";

export type UsageSessionProject = {
    name: string | null;
    gitRemote: string | null;
    gitRoot: string | null;
    gitCommonDir: string | null;
    gitBranch?: string | null;
};

export type UsageSessionState = {
    version: 1;
    sessionId: string;
    sessionFile: string | null;
    cwd: string | null;
    project: UsageSessionProject;
    tags: string[];
};

type SessionEntry = { type?: unknown; customType?: unknown; data?: unknown };

export function isUsageSessionState(value: unknown): value is UsageSessionState {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const state = value as Record<string, unknown>;
    const project = state.project as Record<string, unknown> | null;
    return !Array.isArray(project)
        && state.version === 1
        && typeof state.sessionId === "string"
        && (typeof state.sessionFile === "string" || state.sessionFile === null)
        && (typeof state.cwd === "string" || state.cwd === null)
        && Array.isArray(state.tags)
        && state.tags.every((tag) => typeof tag === "string")
        && !!project
        && (typeof project.name === "string" || project.name === null)
        && (typeof project.gitRemote === "string" || project.gitRemote === null)
        && (typeof project.gitRoot === "string" || project.gitRoot === null)
        && (typeof project.gitCommonDir === "string" || project.gitCommonDir === null)
        && (typeof project.gitBranch === "string" || project.gitBranch === null || project.gitBranch === undefined);
}

/** Returns the latest usage-session snapshot on a session branch. */
export function getUsageSessionState(entries: unknown[]): UsageSessionState | undefined {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index] as SessionEntry;
        if (entry?.type === "custom" && entry.customType === usageSessionCustomType && isUsageSessionState(entry.data)) return entry.data;
    }
    return undefined;
}

/** Reads tags inherited by an isolated child process. Invalid values are ignored. */
export function getInheritedUsageTags(environment: NodeJS.ProcessEnv = process.env): string[] {
    const raw = environment[inheritedUsageTagsEnvironmentVariable];
    if (!raw) return [];
    try {
        const tags = JSON.parse(raw);
        return Array.isArray(tags) && tags.every((tag) => typeof tag === "string") ? normalizeUsageTags(tags) : [];
    } catch {
        return [];
    }
}
