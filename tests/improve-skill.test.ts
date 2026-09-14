import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { parseImproveSkillArguments, readCustomPrompt, skillReviewHelpText } from "../extensions/skills/improve-skill/arguments.ts";
import { buildConsolidationCommand, buildLaunchPlans, safeTabTitle, shellQuote } from "../extensions/skills/improve-skill/launcher.ts";
import { buildReviewPrompt, formatReviewPrompts } from "../extensions/skills/improve-skill/prompt.ts";
import { classifySkillArgument, resolveNamedSkill, resolveSkillPath } from "../extensions/skills/improve-skill/resolver.ts";
import { createSkillReviewRun, createSkillReviewRunId, recordReviewerLaunchFailure, recordRunLaunchFailure, safeSkillDirectoryName, writeSkillReviewPrompts } from "../extensions/skills/improve-skill/run.ts";
import { buildSkillReviewPromptPreview, registerSkillReviewPromptTool } from "../extensions/skills/improve-skill/tool.ts";
import { verifyReviewPrerequisites } from "../extensions/skills/improve-skill/index.ts";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

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
			help: false,
			skillArgument: "example",
			focus: "Swift 6 correctness",
			promptPath: "prompts/review.md",
			showPrompt: false,
		});
		expect(parseImproveSkillArguments("--show-prompt example")).toEqual({
			help: false,
			skillArgument: "example",
			showPrompt: true,
		});
		expect(parseImproveSkillArguments("example --focus '--strict handling'")).toMatchObject({ focus: "--strict handling" });
	});

	it("supports standalone help without resolving a skill", () => {
		expect(parseImproveSkillArguments("--help")).toEqual({ help: true });
		expect(parseImproveSkillArguments("-h")).toEqual({ help: true });
		expect(() => parseImproveSkillArguments("example --help")).toThrow("cannot be combined");
		expect(skillReviewHelpText()).toContain("/skill-review <skill-name-or-absolute-path>");
		expect(skillReviewHelpText()).toContain("--show-prompt");
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

describe("skill-review prompt tool", () => {
	it("registers discoverability guidance for agents", () => {
		let tool: { name?: string; promptSnippet?: string; promptGuidelines?: string[] } | undefined;
		registerSkillReviewPromptTool({ registerTool: (definition: typeof tool) => { tool = definition; } } as unknown as ExtensionAPI);
		expect(tool).toMatchObject({
			name: "skill_review_prompt",
			promptSnippet: expect.stringContaining("exact /skill-review prompts"),
			promptGuidelines: [expect.stringContaining("before asking the user")],
		});
	});

	it("returns the exact default prompts with optional focus and custom composition", async () => {
		const root = await temporaryDirectory();
		const skillDirectory = await addSkill(root, "skills/example");
		const defaults = await buildSkillReviewPromptPreview({ skill: "example" }, root, root);
		expect(defaults.details.skill.directory).toBe(await realpath(skillDirectory));
		expect(defaults.text).toContain("===== Pi =====\n\nYou are the Pi reviewer");
		expect(defaults.text).toContain("===== Codex =====");
		expect(defaults.text).toContain("===== Claude =====");

		await mkdir(join(root, "prompts"));
		await writeFile(join(root, "prompts", "custom.md"), "Custom review instructions.");
		const custom = await buildSkillReviewPromptPreview({ skill: "example", focus: "  Check migrations.  ", promptPath: "prompts/custom.md" }, root, root);
		expect(custom.text).toContain("Custom review instructions.\n\n## Additional review focus\n\nCheck migrations.");
		expect(custom.details).toMatchObject({ focus: "Check migrations." });
		await expect(buildSkillReviewPromptPreview({ skill: "example", focus: "   " }, root, root)).rejects.toThrow("non-empty");
	});
});

describe("improve-skill prerequisites", () => {
	it("uses worktree status to verify Supacode without an unsupported version flag", async () => {
		const calls: Array<[string, string[]]> = [];
		await verifyReviewPrerequisites(async (command, args) => {
			calls.push([command, args]);
			return { code: 0, stdout: "available", stderr: "" };
		}, "worktree-123");

		expect(calls).toContainEqual(["supacode", ["worktree", "status", "-w", "worktree-123"]]);
		expect(calls).not.toContainEqual(["supacode", ["--version"]]);
		expect(calls).toContainEqual(["pi", ["--version"]]);
		expect(calls).toContainEqual(["codex", ["--version"]]);
		expect(calls).toContainEqual(["claude", ["--version"]]);
	});
});

describe("improve-skill launch construction", () => {
	it("uses retained noninteractive read-only sessions captured by the run helper", () => {
		const plans = buildLaunchPlans("/repo path", "/skill path", "/run path", "/runner path", "example", {
			Pi: "pi-session",
			Codex: null,
			Claude: "claude-session",
		});
		expect(plans.map((plan) => plan.reviewer)).toEqual(["Pi", "Codex", "Claude"]);
		expect(plans[0].command).toContain("'node' '/runner path' 'capture' '/run path' 'Pi' '--format' 'text' '--stdin-file' '/run path/prompts/pi.md' '--' 'pi'");
		expect(plans[0].command).toContain("'--name' 'Skill review: example (Pi)' '--session-id' 'pi-session'");
		expect(plans[0].command).toContain("'--tools' 'read,grep,find,ls'");
		expect(plans[1].command).toContain("'Codex' '--format' 'codex-json' '--stdin-file' '/run path/prompts/codex.md' '--' 'codex' 'exec' '--json'");
		expect(plans[1].command).toContain("'--sandbox' 'read-only'");
		expect(plans[2].command).toContain("'--session-id' 'claude-session'");
		expect(plans[2].command).toContain("'--tools' 'Read,Glob,Grep'");
		expect(plans[2].command).toContain("'--add-dir' '/skill path'");
		expect(plans[2].command).toContain("'--stdin-file' '/run path/prompts/claude.md'");
		for (const plan of plans) {
			expect(plan.command).not.toContain("dangerously");
			expect(plan.command).not.toContain("--no-session");
			expect(plan.command).not.toContain("--ephemeral");
		}
		expect(buildConsolidationCommand("/runner path", "/run path")).toBe("'node' '/runner path' 'consolidate' '/run path'");
	});

	it("quotes shell-sensitive command inputs and bounds tab titles", () => {
		expect(shellQuote("a' b; $(bad)")).toBe("'a'\\'' b; $(bad)'");
		expect(safeTabTitle(`name\n${"x".repeat(200)}`)).not.toMatch(/[\n\r]/);
		expect(safeTabTitle("x".repeat(200)).length).toBe(120);
	});

	it("creates private, unique retained run manifests by skill name", async () => {
		const root = await temporaryDirectory();
		const skill = { name: "Example Skill", directory: "/skill", entryPath: "/skill/SKILL.md" };
		const { runDir, record } = await createSkillReviewRun(skill, "/repo", { focus: "Details" }, root);
		expect(runDir).toContain(join(root, "example-skill"));
		expect(record.status).toBe("running");
		expect(record.reviewers.Pi).toMatchObject({ output: "pi.md", model: null, provider: null });
		expect(record.reviewers.Pi.sessionId).toMatch(/^[0-9a-f-]{36}$/);
		expect(record.reviewers.Codex.sessionId).toBeNull();
		expect(record.reviewers.Claude.sessionId).toMatch(/^[0-9a-f-]{36}$/);
		expect(record.consolidated.sessionId).toMatch(/^[0-9a-f-]{36}$/);
		expect(JSON.parse(await (await import("node:fs/promises")).readFile(join(runDir, "run.json"), "utf8"))).toEqual(record);
		await writeSkillReviewPrompts(runDir, { Pi: "Pi prompt", Codex: "Codex prompt", Claude: "Claude prompt" });
		expect(await (await import("node:fs/promises")).readFile(join(runDir, record.reviewers.Pi.prompt), "utf8")).toBe("Pi prompt");
		expect(safeSkillDirectoryName("../../Odd Name")).toBe("odd-name");
		expect(createSkillReviewRunId(new Date("2026-08-22T20:44:25.123Z"), "aabbccdd")).toBe("20260822T204425Z-aabbccdd");

		await recordReviewerLaunchFailure(runDir, "Codex", "launch failed");
		const codexStatus = JSON.parse(await (await import("node:fs/promises")).readFile(join(runDir, "codex.status.json"), "utf8"));
		expect(codexStatus).toMatchObject({ status: "failed", error: "launch failed" });
		await recordRunLaunchFailure(runDir, "tab failed");
		const failedRun = JSON.parse(await (await import("node:fs/promises")).readFile(join(runDir, "run.json"), "utf8"));
		expect(failedRun).toMatchObject({ status: "partial", launchError: "tab failed" });
	});

	it("captures reviewer output and native session metadata", async () => {
		const root = await temporaryDirectory();
		const home = join(root, "home");
		const { runDir, record } = await createSkillReviewRun({ name: "example", directory: "/skill", entryPath: "/skill/SKILL.md" }, "/repo", {}, root);
		const piSessionDirectory = join(home, ".pi", "agent", "sessions", "project");
		await mkdir(piSessionDirectory, { recursive: true });
		await writeFile(join(piSessionDirectory, `session_${record.reviewers.Pi.sessionId}.jsonl`), [
			JSON.stringify({ type: "session", id: record.reviewers.Pi.sessionId }),
			JSON.stringify({ type: "message", message: { role: "assistant", provider: "anthropic", model: "claude-test" } }),
		].join("\n"));
		const runner = join(process.cwd(), "extensions", "skills", "improve-skill", "review-runner.mjs");
		const inputPath = join(root, "input.md");
		await writeFile(inputPath, "@literal prompt");
		await execFileAsync(process.execPath, [runner, "capture", runDir, "Pi", "--format", "text", "--stdin-file", inputPath, "--", process.execPath, "-e", "let value = ''; process.stdin.on('data', chunk => value += chunk); process.stdin.on('end', () => { console.log(value); console.error('note'); });"], { env: { ...process.env, HOME: home, PI_CODING_AGENT_SESSION_DIR: piSessionDirectory } });
		const fs = await import("node:fs/promises");
		expect(await fs.readFile(join(runDir, "pi.md"), "utf8")).toBe("@literal prompt\n");
		expect(await fs.readFile(join(runDir, "pi.stderr.log"), "utf8")).toBe("note\n");
		expect(JSON.parse(await fs.readFile(join(runDir, "pi.status.json"), "utf8"))).toMatchObject({
			status: "complete",
			exitCode: 0,
			sessionId: record.reviewers.Pi.sessionId,
			model: "claude-test",
			provider: "anthropic",
		});
		expect(JSON.parse(await fs.readFile(join(runDir, "run.json"), "utf8")).reviewers.Pi).toMatchObject({
			sessionId: record.reviewers.Pi.sessionId,
			model: "claude-test",
			provider: "anthropic",
		});
	});

	it("extracts the Codex review and session ID from its JSON event stream", async () => {
		const root = await temporaryDirectory();
		const { runDir } = await createSkillReviewRun({ name: "example", directory: "/skill", entryPath: "/skill/SKILL.md" }, "/repo", {}, root);
		const runner = join(process.cwd(), "extensions", "skills", "improve-skill", "review-runner.mjs");
		const codexHome = join(root, "codex-home");
		const codexSessions = join(codexHome, "sessions", "2026", "08", "22");
		await mkdir(codexSessions, { recursive: true });
		await writeFile(join(codexSessions, "rollout-codex-session.jsonl"), [
			JSON.stringify({ type: "session_meta", payload: { session_id: "codex-session", model_provider: "openai" } }),
			JSON.stringify({ type: "turn_context", payload: { model: "gpt-test" } }),
		].join("\n"));
		const events = [
			{ type: "thread.started", thread_id: "codex-session" },
			{ type: "item.completed", item: { type: "agent_message", text: "# Codex review" } },
		];
		await execFileAsync(process.execPath, [runner, "capture", runDir, "Codex", "--format", "codex-json", "--", process.execPath, "-e", `for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event))`], { env: { ...process.env, CODEX_HOME: codexHome } });
		const fs = await import("node:fs/promises");
		expect(await fs.readFile(join(runDir, "codex.md"), "utf8")).toBe("# Codex review\n");
		expect(JSON.parse(await fs.readFile(join(runDir, "codex.status.json"), "utf8"))).toMatchObject({ sessionId: "codex-session", model: "gpt-test", provider: "openai" });
		expect(JSON.parse(await fs.readFile(join(runDir, "run.json"), "utf8")).reviewers.Codex).toMatchObject({ sessionId: "codex-session", model: "gpt-test", provider: "openai" });
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
