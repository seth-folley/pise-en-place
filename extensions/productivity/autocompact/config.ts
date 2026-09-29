import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface AutoCompactConfig {
    enabled: boolean;
    ceilingTokens: number;
}

export const defaults: AutoCompactConfig = { enabled: false, ceilingTokens: 250_000 };
export const configPath = () => path.join(getAgentDir(), "autocompact.json");

export function parseConfig(value: unknown): AutoCompactConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("autocompact.json must contain an object");
    }
    const config = { ...defaults, ...value };
    if (typeof config.enabled !== "boolean") throw new Error("enabled must be a boolean");
    if (!Number.isSafeInteger(config.ceilingTokens) || config.ceilingTokens <= 0) {
        throw new Error("ceilingTokens must be a positive safe integer");
    }
    return { enabled: config.enabled, ceilingTokens: config.ceilingTokens };
}

export async function loadConfig(file = configPath()): Promise<AutoCompactConfig> {
    try {
        return parseConfig(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...defaults };
        throw error;
    }
}

export async function saveConfig(patch: Partial<AutoCompactConfig>, file = configPath()): Promise<AutoCompactConfig> {
    return withFileMutationQueue(file, async () => {
        const config = parseConfig({ ...await loadConfig(file), ...patch });
        await mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
            await rename(temporary, file);
        } finally {
            await rm(temporary, { force: true });
        }
        return config;
    });
}
