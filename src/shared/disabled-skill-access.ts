import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, realpathSync, readFileSync } from "node:fs";
import path from "node:path";
import { getDisabledProjectSkills } from "./context-filter-config.ts";
import { detectProject } from "./project-detection.ts";

export type DisabledSkillDirectory = {
	name: string;
	path: string;
};

type SkillFrontmatter = {
	name?: unknown;
};

function isInside(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalPath(candidate: string): string {
	try {
		return realpathSync(candidate);
	} catch {
		return path.resolve(candidate);
	}
}

function discoverSkillDirectories(root: string, disabledNames: Set<string>): DisabledSkillDirectory[] {
	if (!existsSync(root)) return [];
	const directories: DisabledSkillDirectory[] = [];

	function visit(directory: string): void {
		let entries;
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const child = path.join(directory, entry.name);
			const entryPath = path.join(child, "SKILL.md");
			if (existsSync(entryPath)) {
				try {
					const { frontmatter } = parseFrontmatter<SkillFrontmatter>(readFileSync(entryPath, "utf8"));
					if (typeof frontmatter.name === "string" && disabledNames.has(frontmatter.name)) {
						directories.push({ name: frontmatter.name, path: canonicalPath(child) });
					}
				} catch {
					// An unreadable or malformed skill cannot be matched by name.
				}
			}
			visit(child);
		}
	}

	visit(root);
	return directories;
}

/** Finds canonical directories for disabled project-local skills. */
export function getDisabledSkillDirectories(cwd: string, agentDir?: string): DisabledSkillDirectory[] {
	const disabled = getDisabledProjectSkills(cwd, agentDir);
	if (!disabled.enabled || disabled.skills.length === 0) return [];
	const project = detectProject(cwd);
	if (!project.gitRoot) return [];

	const names = new Set(disabled.skills);
	const roots = [path.join(project.gitRoot, ".pi", "skills"), path.join(project.gitRoot, ".agents", "skills")];
	const directories = roots.flatMap((root) => discoverSkillDirectories(root, names));
	return Array.from(new Map(directories.map((directory) => [directory.path, directory])).values());
}

/** Returns the disabled skill containing a path, resolving symlinks when possible. */
export function disabledSkillForPath(candidate: string, cwd: string, directories = getDisabledSkillDirectories(cwd)): DisabledSkillDirectory | undefined {
	const resolved = canonicalPath(path.resolve(cwd, candidate));
	return directories.find((directory) => isInside(resolved, directory.path));
}

/** Detects literal disabled-skill directory references in a shell command. */
export function disabledSkillForBashCommand(command: string, cwd: string, directories = getDisabledSkillDirectories(cwd)): DisabledSkillDirectory | undefined {
	const normalizedCommand = command.replaceAll("\\", "/");
	const canonicalCwd = canonicalPath(cwd);
	return directories.find((directory) => {
		const absolute = directory.path.replaceAll("\\", "/");
		const aliases = absolute.startsWith("/private/var/") ? [absolute, absolute.replace("/private/var/", "/var/")] : [absolute];
		const relative = path.relative(cwd, directory.path).replaceAll("\\", "/");
		const canonicalRelative = path.relative(canonicalCwd, directory.path).replaceAll("\\", "/");
		return aliases.some((candidate) => normalizedCommand.includes(candidate)) ||
			(relative && normalizedCommand.includes(relative)) ||
			(canonicalRelative && normalizedCommand.includes(canonicalRelative));
	});
}
