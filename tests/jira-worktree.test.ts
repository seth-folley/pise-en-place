import { describe, expect, it } from "vitest";
import { parseJiraWorktreeArguments } from "../extensions/productivity/jira-worktree.ts";

describe("jira worktree arguments", () => {
	it("parses a Jira key without a supplied branch suffix", () => {
		expect(parseJiraWorktreeArguments("iosdox-27280")).toEqual({ key: "IOSDOX-27280", branchSuffix: undefined });
	});

	it("parses a branch suffix before or after the Jira key", () => {
		expect(parseJiraWorktreeArguments("IOSDOX-27280 --branch-suffix add-call-filter")).toEqual({
			key: "IOSDOX-27280",
			branchSuffix: "add-call-filter",
		});
		expect(parseJiraWorktreeArguments("--branch-suffix=add-call-filter IOSDOX-27280")).toEqual({
			key: "IOSDOX-27280",
			branchSuffix: "add-call-filter",
		});
	});

	it("recognizes both help flags", () => {
		expect(parseJiraWorktreeArguments("-h")).toEqual({ help: true });
		expect(parseJiraWorktreeArguments("--help")).toEqual({ help: true });
	});

	it("rejects invalid or missing branch suffixes", () => {
		expect(parseJiraWorktreeArguments("IOSDOX-27280 --branch-suffix").error).toMatch(/requires a slug/);
		expect(parseJiraWorktreeArguments("IOSDOX-27280 --branch-suffix Not_Valid").error).toMatch(/lowercase letters/);
	});

	it("rejects unknown options and extra arguments", () => {
		expect(parseJiraWorktreeArguments("IOSDOX-27280 --suffix foo").error).toBe("Unknown option: --suffix");
		expect(parseJiraWorktreeArguments("IOSDOX-27280 OTHER-1").error).toBe("Unexpected argument: OTHER-1");
	});
});
