import type { ResolvedSkill } from "./resolver.ts";

export type Reviewer = "Pi" | "Codex" | "Claude";

export type ReviewPromptOptions = {
	customPrompt?: string;
	focus?: string;
};

export function buildDefaultReviewPrompt(reviewer: Reviewer, skill: ResolvedSkill): string {
	return [
		`You are the ${reviewer} reviewer in an independent skill-quality review.`,
		`Review the skill at: ${skill.directory}`,
		"",
		"Read SKILL.md completely. Follow and read relevant relative files owned by the skill (Markdown, scripts, schemas, and templates) when needed to assess its instructions.",
		"Analyze the skill exactly as it exists now. Do not compare versions or inspect update metadata.",
		"",
		"You are strictly read-only: do not modify files, run destructive commands, install dependencies, access the network, or ask the user questions.",
		"",
		"Evaluate:",
		"- description and trigger quality;",
		"- clarity, ordering, correctness, and internal consistency of instructions;",
		"- referenced-file integrity;",
		"- ambiguity, redundancy, missing edge cases, and unnecessary complexity;",
		"- safety and permission boundaries;",
		`- compatibility and usability specifically in ${reviewer}.`,
		"",
		"Distinguish evidence-backed findings from preferences. Return readable Markdown with: strengths; findings with file references; harness-specific compatibility notes; and a prioritized conclusion grouped into critical, worthwhile, optional, and leave-as-is.",
	].join("\n");
}

export function buildReviewPrompt(reviewer: Reviewer, skill: ResolvedSkill, options: ReviewPromptOptions = {}): string {
	const prompt = options.customPrompt ?? buildDefaultReviewPrompt(reviewer, skill);
	const focus = options.focus?.trim();
	return focus ? `${prompt.trimEnd()}\n\n## Additional review focus\n\n${focus}` : prompt;
}

export function formatReviewPrompts(skill: ResolvedSkill, options: ReviewPromptOptions = {}): string {
	return (["Pi", "Codex", "Claude"] as Reviewer[])
		.map((reviewer) => `===== ${reviewer} =====\n\n${buildReviewPrompt(reviewer, skill, options)}`)
		.join("\n\n");
}
