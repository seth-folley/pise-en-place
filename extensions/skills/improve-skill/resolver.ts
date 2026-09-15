import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

export type ResolvedSkill = {
	name: string;
	directory: string;
	entryPath: string;
};

export type LoadedSkill = {
	name: string;
	entryPath: string;
};

const skillNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function classifySkillArgument(value: string): { kind: "name" | "path"; value: string } {
	const trimmed = value.trim();
	if (!trimmed) throw new Error("Usage: /skill-review <skill-name-or-absolute-path>");
	if (/[\0-\x1F\x7F]/.test(trimmed)) throw new Error("The skill argument cannot contain control characters.");

	if (trimmed.includes("/")) {
		if (!isAbsolute(trimmed)) throw new Error("Skill paths must be absolute. Use a bare skill name or an absolute path.");
		return { kind: "path", value: trimmed };
	}

	if (!skillNamePattern.test(trimmed) || trimmed === "." || trimmed === "..") {
		throw new Error("Skill names may contain only letters, numbers, dots, underscores, and hyphens.");
	}
	return { kind: "name", value: trimmed };
}

async function readableFile(path: string): Promise<boolean> {
	try {
		const metadata = await stat(path);
		if (!metadata.isFile()) return false;
		await access(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

async function resolveEntry(entryPath: string, name: string): Promise<ResolvedSkill | undefined> {
	if (!await readableFile(entryPath)) return undefined;
	const canonicalEntry = await realpath(entryPath);
	return { name, directory: dirname(canonicalEntry), entryPath: canonicalEntry };
}

export async function resolveNamedSkill(name: string, repositoryRoot: string, agentsSkillsDirectory = join(homedir(), ".agents", "skills")): Promise<ResolvedSkill> {
	const candidates = [
		join(repositoryRoot, "skills", name, "SKILL.md"),
		join(repositoryRoot, ".agents", "skills", name, "SKILL.md"),
		join(agentsSkillsDirectory, name, "SKILL.md"),
	];

	for (const candidate of candidates) {
		const resolved = await resolveEntry(candidate, name);
		if (resolved) return resolved;
	}

	throw new Error(`Could not find a readable SKILL.md for "${name}". Checked:\n${candidates.map((path) => `- ${path}`).join("\n")}`);
}

async function resolveLoadedSkill(skill: LoadedSkill): Promise<ResolvedSkill | undefined> {
	if (!await readableFile(skill.entryPath)) return undefined;
	const canonicalEntry = await realpath(skill.entryPath);
	return { name: skill.name, directory: dirname(canonicalEntry), entryPath: canonicalEntry };
}

export async function resolveSkillPath(inputPath: string): Promise<ResolvedSkill> {
	let canonicalPath: string;
	try {
		canonicalPath = await realpath(inputPath);
	} catch {
		throw new Error(`Skill path does not exist: ${inputPath}`);
	}

	const metadata = await stat(canonicalPath);
	const entryPath = metadata.isDirectory()
		? join(canonicalPath, "SKILL.md")
		: basename(canonicalPath) === "SKILL.md"
			? canonicalPath
			: undefined;

	if (!entryPath) throw new Error("An absolute skill path must be a skill directory or a file named SKILL.md.");
	const resolved = await resolveEntry(entryPath, basename(dirname(entryPath)));
	if (!resolved) throw new Error(`Skill entry must be a readable regular file: ${entryPath}`);
	return resolved;
}

export async function resolveSkill(
	input: string,
	repositoryRoot: string,
	agentsSkillsDirectory?: string,
	loadedSkills: LoadedSkill[] = [],
): Promise<ResolvedSkill> {
	const argument = classifySkillArgument(input);
	if (argument.kind === "path") return resolveSkillPath(argument.value);

	const loaded = loadedSkills.find((skill) => skill.name === argument.value);
	const resolvedLoaded = loaded ? await resolveLoadedSkill(loaded) : undefined;
	return resolvedLoaded ?? resolveNamedSkill(argument.value, repositoryRoot, agentsSkillsDirectory);
}
