import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Reviewer } from "./prompt.ts";
import type { ResolvedSkill } from "./resolver.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export type ReviewArtifact = {
	prompt: string;
	output: string;
	stderr: string;
	status: string;
	sessionId: string | null;
	sessionFile: string | null;
	model: string | null;
	provider: string | null;
};

const artifactPaths = {
	Pi: { prompt: "prompts/pi.md", output: "pi.md", stderr: "pi.stderr.log", status: "pi.status.json" },
	Codex: { prompt: "prompts/codex.md", output: "codex.md", stderr: "codex.stderr.log", status: "codex.status.json" },
	Claude: { prompt: "prompts/claude.md", output: "claude.md", stderr: "claude.stderr.log", status: "claude.status.json" },
} as const;

export type SkillReviewRun = {
	artifactVersion: 1;
	runId: string;
	status: "running" | "consolidating" | "complete" | "partial";
	createdAt: string;
	completedAt?: string;
	launchError?: string;
	repositoryRoot: string;
	skill: ResolvedSkill;
	prompt: { focus?: string; customPromptPath?: string };
	reviewers: Record<Reviewer, ReviewArtifact>;
	consolidated: ReviewArtifact;
};

function timestampId(date: Date): string {
	return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function safeSkillDirectoryName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "skill";
}

export function createSkillReviewRunId(date = new Date(), randomSuffix = randomBytes(4).toString("hex")): string {
	return `${timestampId(date)}-${randomSuffix}`;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	const partialPath = `${filePath}.${process.pid}.partial`;
	await writeFile(partialPath, `${JSON.stringify(value, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
	await rename(partialPath, filePath);
}

async function updateRunManifest(runDir: string, update: (run: SkillReviewRun) => SkillReviewRun): Promise<void> {
	const lockPath = path.join(runDir, ".run-json.lock");
	for (let attempt = 0; ; attempt += 1) {
		try {
			await mkdir(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
			break;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST") || attempt >= 200) throw error;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	try {
		const manifestPath = path.join(runDir, "run.json");
		const run = JSON.parse(await readFile(manifestPath, "utf8")) as SkillReviewRun;
		await writeJsonAtomic(manifestPath, update(run));
	} finally {
		await rmdir(lockPath).catch(() => undefined);
	}
}

export async function writeSkillReviewPrompts(runDir: string, prompts: Record<Reviewer, string>): Promise<void> {
	await mkdir(path.join(runDir, "prompts"), { mode: PRIVATE_DIRECTORY_MODE });
	await Promise.all((Object.keys(artifactPaths) as Reviewer[]).map((reviewer) =>
		writeFile(path.join(runDir, artifactPaths[reviewer].prompt), prompts[reviewer], { mode: PRIVATE_FILE_MODE })));
}

export async function recordReviewerLaunchFailure(runDir: string, reviewer: Reviewer, message: string): Promise<void> {
	const artifact = artifactPaths[reviewer];
	const now = new Date().toISOString();
	await Promise.all([
		writeFile(path.join(runDir, artifact.output), "", { mode: PRIVATE_FILE_MODE }),
		writeFile(path.join(runDir, artifact.stderr), `${message}\n`, { mode: PRIVATE_FILE_MODE }),
		writeJsonAtomic(path.join(runDir, artifact.status), {
			status: "failed",
			exitCode: null,
			signal: null,
			startedAt: now,
			completedAt: now,
			error: message,
		}),
	]);
}

export async function recordRunLaunchFailure(runDir: string, message: string): Promise<void> {
	await updateRunManifest(runDir, (run) => ({ ...run, status: "partial", completedAt: new Date().toISOString(), launchError: message }));
}

export async function createSkillReviewRun(
	skill: ResolvedSkill,
	repositoryRoot: string,
	prompt: SkillReviewRun["prompt"],
	baseDirectory = path.join(homedir(), ".pi", "agent", "skill-reviews"),
): Promise<{ runDir: string; record: SkillReviewRun }> {
	const runId = createSkillReviewRunId();
	const skillDirectory = path.join(baseDirectory, safeSkillDirectoryName(skill.name));
	const runDir = path.join(skillDirectory, runId);
	await mkdir(skillDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
	await mkdir(runDir, { mode: PRIVATE_DIRECTORY_MODE });

	const metadata = { sessionFile: null, model: null, provider: null };
	const record: SkillReviewRun = {
		artifactVersion: 1,
		runId,
		status: "running",
		createdAt: new Date().toISOString(),
		repositoryRoot,
		skill,
		prompt,
		reviewers: {
			Pi: { ...artifactPaths.Pi, sessionId: randomUUID(), ...metadata },
			Codex: { ...artifactPaths.Codex, sessionId: null, ...metadata },
			Claude: { ...artifactPaths.Claude, sessionId: randomUUID(), ...metadata },
		},
		consolidated: {
			prompt: "prompts/consolidated.md",
			output: "consolidated.md",
			stderr: "consolidated.stderr.log",
			status: "consolidated.status.json",
			sessionId: randomUUID(),
			...metadata,
		},
	};
	await writeFile(path.join(runDir, "run.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
	return { runDir, record };
}
