import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { detectProject, expandHome } from "./project-detection.ts";

type SkillFrontmatter = {
	name?: unknown;
};

export type ResolvedProjectSkill = {
	name: string;
	entryPath: string;
	projectId: string;
	gitRoot: string;
};

type SkillCommand = {
	name: string;
	source: string;
	sourceInfo: {
		path: string;
		scope: string;
	};
};

export type SkillPathCompletion = {
	value: string;
	label: string;
	description: string;
};

export function getProjectSkillPathCompletions(commands: SkillCommand[], cwd: string, prefix: string): SkillPathCompletion[] {
	if (!prefix.startsWith("disable ")) return [];
	const typedPath = prefix.slice("disable ".length);
	const seenPaths = new Set<string>();

	return commands
		.filter((command) => command.source === "skill" && command.sourceInfo.scope === "project")
		.flatMap((command) => {
			const entryPath = command.sourceInfo.path;
			if (path.basename(entryPath) !== "SKILL.md") return [];
			const relativeParts = path.relative(cwd, entryPath).split(path.sep);
			const isProjectSkillPath = relativeParts.some((part, index) =>
				(part === ".pi" || part === ".agents") && relativeParts[index + 1] === "skills"
			);
			if (!isProjectSkillPath) return [];

			const skillPath = path.relative(cwd, path.dirname(entryPath)) || ".";
			if (!skillPath.startsWith(typedPath) || seenPaths.has(skillPath)) return [];
			seenPaths.add(skillPath);
			return [{
				value: `disable ${skillPath}`,
				label: command.name.replace(/^skill:/, ""),
				description: skillPath,
			}];
		})
		.sort((left, right) => left.label.localeCompare(right.label));
}

function isInside(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveProjectSkill(skillPath: string, cwd: string): Promise<ResolvedProjectSkill> {
	if (!skillPath.trim()) throw new Error("Usage: /skillz disable <skill_path>");

	const project = detectProject(cwd);
	if (!project.id || !project.gitRoot) {
		throw new Error(`Cannot identify the current project: ${project.error ?? "Git project unavailable"}.`);
	}

	const requestedPath = path.resolve(cwd, expandHome(skillPath.trim()));
	let requestedStats;
	try {
		requestedStats = await stat(requestedPath);
	} catch {
		throw new Error(`Skill path does not exist: ${requestedPath}`);
	}

	const candidatePath = requestedStats.isDirectory()
		? path.join(requestedPath, "SKILL.md")
		: requestedPath;
	if (path.basename(candidatePath) !== "SKILL.md") {
		throw new Error("Skill path must be a skill directory or a file named SKILL.md.");
	}

	let entryPath: string;
	try {
		entryPath = await realpath(candidatePath);
	} catch {
		throw new Error(`Skill entry file does not exist: ${candidatePath}`);
	}
	const gitRoot = await realpath(project.gitRoot);
	if (!isInside(entryPath, gitRoot)) {
		throw new Error(`Skill must be project-local (inside ${gitRoot}).`);
	}
	const relativeParts = path.relative(gitRoot, entryPath).split(path.sep);
	const isProjectSkillPath = relativeParts.some((part, index) =>
		(part === ".pi" || part === ".agents") && relativeParts[index + 1] === "skills"
	);
	if (!isProjectSkillPath) {
		throw new Error("Skill must be under a project-local .pi/skills or .agents/skills directory.");
	}

	const { frontmatter } = parseFrontmatter<SkillFrontmatter>(await readFile(entryPath, "utf8"));
	if (typeof frontmatter.name !== "string" || !frontmatter.name.trim()) {
		throw new Error(`Skill has no valid frontmatter name: ${entryPath}`);
	}

	return {
		name: frontmatter.name.trim(),
		entryPath,
		projectId: project.id,
		gitRoot,
	};
}
