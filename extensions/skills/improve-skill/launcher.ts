import path from "node:path";
import type { Reviewer } from "./prompt.ts";

export type LaunchPlan = {
	reviewer: Reviewer;
	command: string;
};

/** Quotes an argv item for the shell which Supacode uses to start a surface. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function shellCommand(argv: string[]): string {
	return argv.map(shellQuote).join(" ");
}

export function safeTabTitle(skillName: string): string {
	const cleaned = skillName.replace(/[\0-\x1F\x7F]/g, " ").trim() || "skill";
	return `Skill review: ${cleaned}`.slice(0, 120);
}

function capturedCommand(runnerPath: string, runDir: string, reviewer: Reviewer, argv: string[], format = "text", stdinFile?: string): string {
	return shellCommand(["node", runnerPath, "capture", runDir, reviewer, "--format", format, ...(stdinFile ? ["--stdin-file", stdinFile] : []), "--", ...argv]);
}

export function buildLaunchPlans(
	repositoryRoot: string,
	skillDirectory: string,
	runDir: string,
	runnerPath: string,
	skillName: string,
	sessionIds: Record<Reviewer, string | null>,
): LaunchPlan[] {
	return [
		{
			reviewer: "Pi",
			command: capturedCommand(runnerPath, runDir, "Pi", [
				"pi", "--print", "--no-extensions", "--no-skills", "--name", `Skill review: ${skillName} (Pi)`,
				"--session-id", sessionIds.Pi!, "--tools", "read,grep,find,ls",
			], "text", path.join(runDir, "prompts", "pi.md")),
		},
		{
			reviewer: "Codex",
			command: capturedCommand(runnerPath, runDir, "Codex", [
				"codex", "exec", "--json", "--sandbox", "read-only", "--cd", repositoryRoot,
			], "codex-json", path.join(runDir, "prompts", "codex.md")),
		},
		{
			reviewer: "Claude",
			command: capturedCommand(runnerPath, runDir, "Claude", [
				"claude", "--print", "--name", `Skill review: ${skillName} (Claude)`, "--session-id", sessionIds.Claude!,
				"--permission-mode", "dontAsk", "--permission-prompts", "none",
				"--tools", "Read,Glob,Grep", "--add-dir", skillDirectory,
			], "text", path.join(runDir, "prompts", "claude.md")),
		},
	];
}

export function buildConsolidationCommand(runnerPath: string, runDir: string): string {
	return shellCommand(["node", runnerPath, "consolidate", runDir]);
}
