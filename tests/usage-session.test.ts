import { describe, expect, it } from "vitest";
import { getInheritedUsageTags, getUsageSessionState, inheritedUsageTagsEnvironmentVariable, type UsageSessionState } from "../src/shared/usage-session.ts";

const state: UsageSessionState = {
    version: 1,
    sessionId: "session-1",
    sessionFile: "/tmp/session.jsonl",
    cwd: "/tmp/project",
    project: { name: "project", gitRemote: "github.com/example/project", gitRoot: "/tmp/project", gitCommonDir: "/tmp/project/.git", gitBranch: "main" },
    tags: ["ios"],
};

describe("usage session state", () => {
    it("uses the latest valid state on the active branch", () => {
        expect(getUsageSessionState([
            { type: "custom", customType: "usage-session", data: { version: 1 } },
            { type: "custom", customType: "usage-session", data: { ...state, tags: ["old"] } },
            { type: "custom", customType: "usage-session", data: state },
        ])).toEqual(state);
    });

    it("normalizes inherited child tags and rejects malformed values", () => {
        expect(getInheritedUsageTags({ [inheritedUsageTagsEnvironmentVariable]: JSON.stringify(["ios", "subagent", "ios"]) })).toEqual(["ios", "subagent"]);
        expect(getInheritedUsageTags({ [inheritedUsageTagsEnvironmentVariable]: "not-json" })).toEqual([]);
    });
});
