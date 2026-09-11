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
	return `Improve skill: ${cleaned}`.slice(0, 120);
}

export function buildLaunchPlans(promptByReviewer: Record<Reviewer, string>, repositoryRoot: string, skillDirectory: string): LaunchPlan[] {
	return [
		{
			reviewer: "Pi",
			command: shellCommand([
				"pi", "--print", "--no-session", "--no-extensions", "--no-skills",
				"--tools", "read,grep,find,ls", promptByReviewer.Pi,
			]),
		},
		{
			reviewer: "Codex",
			command: shellCommand([
				"codex", "exec", "--ephemeral", "--sandbox", "read-only", "--cd", repositoryRoot, promptByReviewer.Codex,
			]),
		},
		{
			reviewer: "Claude",
			command: shellCommand([
				"claude", "--print", "--no-session-persistence", "--permission-mode", "dontAsk", "--permission-prompts", "none",
				"--tools", "Read,Glob,Grep", "--add-dir", skillDirectory, promptByReviewer.Claude,
			]),
		},
	];
}
