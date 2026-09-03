import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ResolvedSubagentConfig, ThinkingLevel } from "./config.ts";

export type SubagentDefinition = {
    name: string;
    description: string;
    tools: string[];
    systemPrompt: string;
    defaults: ResolvedSubagentConfig;
};

type Frontmatter = {
    name?: unknown;
    description?: unknown;
    tools?: unknown;
    model?: unknown;
    thinking?: unknown;
};

const definitionDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");
const allowedThinkingLevels = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function parseTools(value: unknown): string[] {
    const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
    return raw.filter((tool): tool is string => typeof tool === "string").map((tool) => tool.trim()).filter(Boolean);
}

function parseDefinition(fileName: string): SubagentDefinition | undefined {
    const filePath = path.join(definitionDirectory, fileName);
    const { frontmatter, body } = parseFrontmatter<Frontmatter>(readFileSync(filePath, "utf8"));
    if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") return undefined;
    if (typeof frontmatter.model !== "string" || !frontmatter.model.trim()) return undefined;
    if (typeof frontmatter.thinking !== "string" || !allowedThinkingLevels.has(frontmatter.thinking as ThinkingLevel)) return undefined;
    const tools = parseTools(frontmatter.tools);
    if (tools.length === 0 || !body.trim()) return undefined;
    return {
        name: frontmatter.name,
        description: frontmatter.description,
        tools,
        systemPrompt: body.trim(),
        defaults: { model: frontmatter.model.trim(), thinking: frontmatter.thinking as ThinkingLevel },
    };
}

/** Loads package-owned definitions only; projects cannot add or replace roles. */
export function getSubagentDefinitions(): SubagentDefinition[] {
    try {
        return readdirSync(definitionDirectory)
            .filter((file) => file.endsWith(".md"))
            .sort()
            .flatMap((file) => {
                try {
                    const definition = parseDefinition(file);
                    return definition ? [definition] : [];
                } catch {
                    return [];
                }
            });
    } catch {
        return [];
    }
}
