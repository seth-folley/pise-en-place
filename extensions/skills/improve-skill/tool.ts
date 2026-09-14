import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readCustomPrompt } from "./arguments.ts";
import { formatReviewPrompts } from "./prompt.ts";
import { resolveSkill } from "./resolver.ts";

export type SkillReviewPromptInput = {
	skill: string;
	focus?: string;
	promptPath?: string;
};

export async function buildSkillReviewPromptPreview(
	input: SkillReviewPromptInput,
	repositoryRoot: string,
	cwd: string,
): Promise<{
	text: string;
	details: {
		skill: Awaited<ReturnType<typeof resolveSkill>>;
		focus?: string;
		customPromptPath?: string;
	};
}> {
	const focus = input.focus?.trim();
	if (input.focus !== undefined && !focus) throw new Error("focus requires a non-empty value.");
	const skill = await resolveSkill(input.skill, repositoryRoot);
	const custom = input.promptPath ? await readCustomPrompt(input.promptPath, cwd) : undefined;
	const options = { customPrompt: custom?.content, focus };
	return {
		text: [
			`Resolved skill: ${skill.directory}`,
			...(custom ? [`Custom prompt: ${custom.path}`] : []),
			"",
			formatReviewPrompts(skill, options),
		].join("\n"),
		details: {
			skill,
			...(focus ? { focus } : {}),
			...(custom ? { customPromptPath: custom.path } : {}),
		},
	};
}

export function registerSkillReviewPromptTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "skill_review_prompt",
		label: "Skill review prompt",
		description: "Resolve a skill and return the exact Pi, Codex, and Claude prompts that /skill-review would use. Optionally compose additional focus criteria or a replacement Markdown prompt. This is read-only and does not launch reviewers. Output is capped at 50KB or 2,000 lines.",
		promptSnippet: "Inspect the exact /skill-review prompts before proposing focus areas or a replacement prompt",
		promptGuidelines: [
			"Use skill_review_prompt before asking the user for /skill-review focus areas or proposing a replacement review prompt.",
		],
		parameters: Type.Object({
			skill: Type.String({ minLength: 1, description: "Bare skill name or absolute path to its directory or SKILL.md" }),
			focus: Type.Optional(Type.String({ minLength: 1, description: "Additional review criteria to append to every prompt" })),
			promptPath: Type.Optional(Type.String({ minLength: 1, description: "Markdown file whose contents replace the built-in review prompt" })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const git = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd, signal });
			if (git.code !== 0 || !git.stdout.trim()) {
				throw new Error(`Unable to find the Git repository root: ${[git.stderr, git.stdout].filter(Boolean).join("\n").trim() || `exit ${git.code}`}`);
			}
			const preview = await buildSkillReviewPromptPreview(params, git.stdout.trim(), ctx.cwd);
			const truncated = truncateHead(preview.text, {
				maxBytes: DEFAULT_MAX_BYTES - 512,
				maxLines: DEFAULT_MAX_LINES - 5,
			});
			const notice = truncated.truncated
				? "\n\n[Prompt preview truncated to fit the tool-result limit. Read the referenced custom prompt file directly for its complete contents.]"
				: "";
			return {
				content: [{ type: "text", text: `${truncated.content}${notice}` }],
				details: { ...preview.details, truncated: truncated.truncated },
			};
		},
	});
}
