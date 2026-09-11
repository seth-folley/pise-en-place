import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseImproveSkillArguments, readCustomPrompt } from "../extensions/skills/improve-skill/arguments.ts";
import { buildLaunchPlans, safeTabTitle, shellQuote } from "../extensions/skills/improve-skill/launcher.ts";
import { buildReviewPrompt, formatReviewPrompts } from "../extensions/skills/improve-skill/prompt.ts";
import { classifySkillArgument, resolveNamedSkill, resolveSkillPath } from "../extensions/skills/improve-skill/resolver.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
	const directory = await mkdtemp(join(tmpdir(), "improve-skill-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function addSkill(root: string, relativeDirectory: string, content = "# Skill\n") {
	const directory = join(root, relativeDirectory);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "SKILL.md"), content);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
		await (await import("node:fs/promises")).rm(directory, { recursive: true, force: true });
	}));
});

describe("improve-skill resolution", () => {
	it("uses local skills before project and global .agents skills", async () => {
		const root = await temporaryDirectory();
		const global = await temporaryDirectory();
		const local = await realpath(await addSkill(root, "skills/example", "local"));
		await addSkill(root, ".agents/skills/example", "project agent");
		await addSkill(global, "example", "global");

		const resolved = await resolveNamedSkill("example", root, global);
		expect(resolved.directory).toBe(local);
	});

	it("falls back from project .agents skills to global skills", async () => {
		const root = await temporaryDirectory();
		const global = await temporaryDirectory();
		const project = await realpath(await addSkill(root, ".agents/skills/example"));
		expect((await resolveNamedSkill("example", root, global)).directory).toBe(project);

		const secondRoot = await temporaryDirectory();
		const globalOnly = await realpath(await addSkill(global, "global-only"));
		expect((await resolveNamedSkill("global-only", secondRoot, global)).directory).toBe(globalOnly);
	});

	it("reports every named-skill location when none is valid", async () => {
		const root = await temporaryDirectory();
		const global = await temporaryDirectory();
		await expect(resolveNamedSkill("missing", root, global)).rejects.toThrow(join(root, "skills", "missing", "SKILL.md"));
		await expect(resolveNamedSkill("missing", root, global)).rejects.toThrow(join(global, "missing", "SKILL.md"));
	});

	it("accepts a skill directory or SKILL.md and resolves symlinks", async () => {
		const root = await temporaryDirectory();
		const skill = await realpath(await addSkill(root, "skills/example"));
		expect((await resolveSkillPath(skill)).directory).toBe(skill);
		expect((await resolveSkillPath(join(skill, "SKILL.md"))).directory).toBe(skill);

		const link = join(root, "linked-skill");
		await symlink(skill, link);
		expect((await resolveSkillPath(link)).directory).toBe(skill);
	});

	it("rejects empty, relative, and invalid bare inputs", () => {
		expect(() => classifySkillArgument("")).toThrow("Usage");
		expect(() => classifySkillArgument("skills/example")).toThrow("absolute");
		expect(() => classifySkillArgument("../example")).toThrow("absolute");
		expect(() => classifySkillArgument("bad name")).toThrow("Skill names");
	});
});

describe("improve-skill arguments", () => {
	it("parses focus, custom prompt, and exact default-prompt preview options", () => {
		expect(parseImproveSkillArguments("example --focus 'Swift 6 correctness' --prompt prompts/review.md")).toEqual({
			skillArgument: "example",
			focus: "Swift 6 correctness",
			promptPath: "prompts/review.md",
			showPrompt: false,
		});
		expect(parseImproveSkillArguments("--show-prompt example")).toEqual({
			skillArgument: "example",
			showPrompt: true,
		});
		expect(parseImproveSkillArguments("example --focus '--strict handling'").focus).toBe("--strict handling");
	});

	it("allows previewing composed options and rejects duplicate, unknown, and malformed options", () => {
		expect(parseImproveSkillArguments("example --show-prompt --focus details")).toMatchObject({
			showPrompt: true,
			focus: "details",
		});
		expect(() => parseImproveSkillArguments("example --focus one --focus two")).toThrow("only be provided once");
		expect(() => parseImproveSkillArguments("example --unknown")).toThrow("Unknown option");
		expect(() => parseImproveSkillArguments("example --focus 'unfinished")).toThrow("unterminated");
	});

	it("loads non-empty Markdown prompt files relative to the current directory", async () => {
		const root = await temporaryDirectory();
		await mkdir(join(root, "prompts"));
		await writeFile(join(root, "prompts", "review.md"), "\nCustom review instructions.\n");
		const loaded = await readCustomPrompt("prompts/review.md", root);
		expect(loaded.path).toBe(await realpath(join(root, "prompts", "review.md")));
		expect(loaded.content).toBe("\nCustom review instructions.\n");
		await expect(readCustomPrompt("prompts/review.txt", root)).rejects.toThrow("Markdown file");
	});
});

describe("improve-skill launch construction", () => {
	const prompts = {
		Pi: "Pi prompt",
		Codex: "Codex prompt",
		Claude: "Claude prompt",
	};

	it("uses noninteractive read-only plans without dangerous bypass flags", () => {
		const plans = buildLaunchPlans(prompts, "/repo path", "/skill path");
		expect(plans.map((plan) => plan.reviewer)).toEqual(["Pi", "Codex", "Claude"]);
		expect(plans[0].command).toContain("'--tools' 'read,grep,find,ls'");
		expect(plans[1].command).toContain("'--sandbox' 'read-only'");
		expect(plans[2].command).toContain("'--tools' 'Read,Glob,Grep'");
		for (const plan of plans) expect(plan.command).not.toContain("dangerously");
	});

	it("quotes shell-sensitive command inputs and bounds tab titles", () => {
		expect(shellQuote("a' b; $(bad)")).toBe("'a'\\'' b; $(bad)'");
		expect(safeTabTitle(`name\n${"x".repeat(200)}`)).not.toMatch(/[\n\r]/);
		expect(safeTabTitle("x".repeat(200)).length).toBe(120);
	});

	it("builds default, focused, custom, and preview prompts", () => {
		const skill = { name: "example", directory: "/skill", entryPath: "/skill/SKILL.md" };
		expect(buildReviewPrompt("Pi", skill)).toContain("specifically in Pi");
		expect(buildReviewPrompt("Codex", skill)).toContain("Review the skill at: /skill");
		expect(buildReviewPrompt("Pi", skill, { focus: "Check edge cases." })).toContain("## Additional review focus\n\nCheck edge cases.");
		expect(buildReviewPrompt("Claude", skill, { customPrompt: "Custom prompt", focus: "Focus here" })).toBe(
			"Custom prompt\n\n## Additional review focus\n\nFocus here",
		);
		const preview = formatReviewPrompts(skill);
		expect(preview).toContain("===== Pi =====\n\nYou are the Pi reviewer");
		expect(preview).toContain("===== Claude =====\n\nYou are the Claude reviewer");
		expect(preview).toContain("Review the skill at: /skill");
		const customPreview = formatReviewPrompts(skill, { customPrompt: "Custom", focus: "Details" });
		expect(customPreview).toContain("===== Pi =====\n\nCustom\n\n## Additional review focus\n\nDetails");
	});
});
