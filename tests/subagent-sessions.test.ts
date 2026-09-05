import { describe, expect, it } from "vitest";
import { formatSubagentSessionRuns, getSubagentSessionRuns, resumeSubagentSessionCommand, type SubagentSessionRun } from "../extensions/orchestration/subagent/sessions.ts";

const run: SubagentSessionRun = {
    version: 1,
    parentSessionId: "11111111-1111-4111-8111-111111111111",
    toolCallId: "tool-1",
    agent: "scout",
    task: "Inspect the package",
    childSessionId: "22222222-2222-4222-8222-222222222222",
    sessionDir: "/tmp/agent's sessions",
    startedAt: "2026-03-10T10:00:00.000Z",
    completedAt: "2026-03-10T10:01:00.000Z",
    exitCode: 0,
};

describe("retained subagent sessions", () => {
    it("extracts only valid child-session links", () => {
        expect(getSubagentSessionRuns([
            { type: "custom", customType: "other", data: run },
            { type: "custom", customType: "subagent-session", data: { version: 1 } },
            { type: "custom", customType: "subagent-session", data: run },
        ])).toEqual([run]);
    });

    it("formats a command that uses the isolated session directory", () => {
        expect(resumeSubagentSessionCommand(run)).toBe("pi --session-dir '/tmp/agent'\\''s sessions' --session 22222222-2222-4222-8222-222222222222");
        expect(formatSubagentSessionRuns([run])).toContain("scout — completed");
    });
});
