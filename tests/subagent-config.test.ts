import { describe, expect, it } from "vitest";
import { resolveSubagentConfig, type ResolvedSubagentConfig, type SubagentsConfig } from "../extensions/orchestration/subagent/config.ts";

const builtIn: ResolvedSubagentConfig = { model: "anthropic/claude-haiku-4-5", thinking: "low" };

describe("subagent configuration", () => {
    it("applies global and project defaults before role-specific overrides", () => {
        const globalConfig: SubagentsConfig = {
            defaults: { model: "anthropic/claude-sonnet-4-5", thinking: "medium" },
            agents: { scout: { thinking: "high" } },
        };
        const projectConfig: SubagentsConfig = {
            defaults: { thinking: "low" },
            agents: { scout: { model: "openai/gpt-5" } },
        };

        expect(resolveSubagentConfig("scout", builtIn, globalConfig, projectConfig)).toEqual({
            model: "openai/gpt-5",
            thinking: "low",
        });
    });

    it("retains package role defaults when no settings are configured", () => {
        expect(resolveSubagentConfig("scout", builtIn)).toEqual(builtIn);
    });
});
