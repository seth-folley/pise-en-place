import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { disableProjectSkill, getDisabledProjectSkills } from "../src/shared/context-filter-config.ts";
import { disabledSkillForBashCommand, disabledSkillForPath, getDisabledSkillDirectories } from "../src/shared/disabled-skill-access.ts";
import { getProjectSkillPathCompletions, resolveProjectSkill } from "../src/shared/project-skill.ts";

const temporaryPaths: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryPaths.push(directory);
	return directory;
}

async function projectFixture(): Promise<{ root: string; skillDirectory: string; skillPath: string }> {
	const root = await temporaryDirectory("skillz-project-");
	execFileSync("git", ["init", "-q", root]);
	execFileSync("git", ["-C", root, "remote", "add", "origin", "git@github.com:example/project.git"]);
	const skillDirectory = path.join(root, ".agents", "skills", "example-skill");
	const skillPath = path.join(skillDirectory, "SKILL.md");
	await mkdir(skillDirectory, { recursive: true });
	await writeFile(skillPath, "---\nname: example-skill\ndescription: Example\n---\n\n# Example\n", "utf8");
	return { root, skillDirectory, skillPath };
}

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("project skill path completion", () => {
	it("suggests discovered project skill directories by name and path", () => {
		const cwd = path.join(path.sep, "repo");
		const commands = [
			{
				name: "skill:beta-skill",
				source: "skill",
				sourceInfo: { path: path.join(cwd, ".agents", "skills", "beta", "SKILL.md"), scope: "project" },
			},
			{
				name: "skill:alpha-skill",
				source: "skill",
				sourceInfo: { path: path.join(cwd, ".pi", "skills", "alpha", "SKILL.md"), scope: "project" },
			},
			{
				name: "skill:global-skill",
				source: "skill",
				sourceInfo: { path: path.join(path.sep, "global", "skills", "global", "SKILL.md"), scope: "user" },
			},
		];

		expect(getProjectSkillPathCompletions(commands, cwd, "disable ")).toEqual([
			{ value: `disable ${path.join(".pi", "skills", "alpha")}`, label: "alpha-skill", description: path.join(".pi", "skills", "alpha") },
			{ value: `disable ${path.join(".agents", "skills", "beta")}`, label: "beta-skill", description: path.join(".agents", "skills", "beta") },
		]);
		expect(getProjectSkillPathCompletions(commands, cwd, "disable .agents")).toEqual([
			{ value: `disable ${path.join(".agents", "skills", "beta")}`, label: "beta-skill", description: path.join(".agents", "skills", "beta") },
		]);
	});
});

describe("project skill resolution", () => {
	it("accepts a project-local skill directory or SKILL.md path", async () => {
		const fixture = await projectFixture();
		await expect(resolveProjectSkill(fixture.skillDirectory, fixture.root)).resolves.toMatchObject({
			name: "example-skill",
			entryPath: await realpath(fixture.skillPath),
			projectId: "github.com:example/project",
		});
		await expect(resolveProjectSkill(fixture.skillPath, fixture.root)).resolves.toMatchObject({ name: "example-skill" });
	});

	it("rejects a skill outside the current project", async () => {
		const fixture = await projectFixture();
		const outside = await temporaryDirectory("skillz-outside-");
		await writeFile(path.join(outside, "SKILL.md"), "---\nname: outside\ndescription: Outside\n---\n", "utf8");
		await expect(resolveProjectSkill(outside, fixture.root)).rejects.toThrow("must be project-local");
	});

	it("rejects SKILL.md files outside project skill roots", async () => {
		const fixture = await projectFixture();
		const docsDirectory = path.join(fixture.root, "docs", "example");
		await mkdir(docsDirectory, { recursive: true });
		await writeFile(path.join(docsDirectory, "SKILL.md"), "---\nname: unrelated\ndescription: Unrelated\n---\n", "utf8");
		await expect(resolveProjectSkill(docsDirectory, fixture.root)).rejects.toThrow(".pi/skills or .agents/skills");
	});
});

describe("project skill disabling", () => {
	it("preserves settings and adds a sorted, idempotent project ignore entry", async () => {
		const agentDir = await temporaryDirectory("skillz-agent-");
		await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
			theme: "dracula-pro",
			contextFileFilter: {
				enabled: true,
				projects: {
					"github.com:example/project": {
						enabled: true,
						ignore: ["AGENTS.md"],
						skills: { enabled: true, scope: "names", ignore: ["zebra-skill"] },
					},
				},
			},
		}, null, 2));

		const first = disableProjectSkill("github.com:example/project", "example-skill", agentDir, agentDir);
		expect(first.alreadyDisabled).toBe(false);
		expect(first.rule).toMatchObject({
			enabled: true,
			ignore: ["AGENTS.md"],
			skills: { enabled: true, scope: "names", ignore: ["example-skill", "zebra-skill"] },
		});
		expect(disableProjectSkill("github.com:example/project", "example-skill", agentDir, agentDir).alreadyDisabled).toBe(true);

		const settings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
		expect(settings.theme).toBe("dracula-pro");
		expect(settings.contextFileFilter.enabled).toBe(true);
		expect(settings.contextFileFilter.projects["github.com:example/project"].skills.ignore).toEqual([
			"example-skill",
			"zebra-skill",
		]);
	});

	it("resolves disabled skill directories and blocks all files beneath them", async () => {
		const fixture = await projectFixture();
		const agentDir = await temporaryDirectory("skillz-access-agent-");
		await mkdir(path.join(fixture.skillDirectory, "references"), { recursive: true });
		const referencePath = path.join(fixture.skillDirectory, "references", "guide.md");
		await writeFile(referencePath, "# Private skill reference\n", "utf8");
		await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
			contextFileFilter: {
				enabled: true,
				projects: {
					"github.com:example/project": { skills: { enabled: true, ignore: ["example-skill"] } },
				},
			},
		}));

		const directories = getDisabledSkillDirectories(fixture.root, agentDir);
		expect(directories).toHaveLength(1);
		expect(directories[0].name).toBe("example-skill");
		expect(disabledSkillForPath(referencePath, fixture.root, directories)?.name).toBe("example-skill");
		expect(disabledSkillForBashCommand(`cat ${referencePath}`, fixture.root, directories)?.name).toBe("example-skill");
		expect(disabledSkillForPath(path.join(fixture.root, "README.md"), fixture.root, directories)).toBeUndefined();
	});

	it("reports effective disabled skills for the current project", async () => {
		const fixture = await projectFixture();
		const agentDir = await temporaryDirectory("skillz-list-agent-");
		await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
			contextFileFilter: {
				enabled: true,
				projects: {
					"github.com:example/project": {
						enabled: true,
						skills: { enabled: true, scope: "names", ignore: ["zebra-skill", "alpha-skill"] },
					},
				},
			},
		}));

		expect(getDisabledProjectSkills(fixture.root, agentDir)).toEqual({
			projectId: "github.com:example/project",
			enabled: true,
			skills: ["alpha-skill", "zebra-skill"],
		});
	});

	it("refuses to activate a disabled filter or overwrite a project-local rule", async () => {
		const agentDir = await temporaryDirectory("skillz-disabled-agent-");
		const project = await temporaryDirectory("skillz-filter-project-");
		await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
			contextFileFilter: { enabled: false },
		}));
		expect(() => disableProjectSkill("github.com:example/project", "example-skill", project, agentDir)).toThrow("context filter is disabled");

		await writeFile(path.join(agentDir, "settings.json"), "{}", "utf8");
		await mkdir(path.join(project, ".pi"), { recursive: true });
		await writeFile(path.join(project, ".pi", "settings.json"), JSON.stringify({
			contextFileFilter: {
				projects: {
					"github.com:example/project": { skills: { enabled: true, ignore: [] } },
				},
			},
		}));
		expect(() => disableProjectSkill("github.com:example/project", "example-skill", project, agentDir)).toThrow("overrides the user-level context filter");
	});
});
