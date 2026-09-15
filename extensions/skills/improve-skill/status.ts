import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Reviewer } from "./prompt.ts";
import type { ReviewArtifact, SkillReviewRun } from "./run.ts";

export type ReviewWorkState = "working" | "finished" | "failed" | "timed-out" | "waiting" | "not-run";

export type SkillReviewProgress = {
	skillName: string;
	runStatus: SkillReviewRun["status"];
	reviewers: Record<Reviewer, ReviewWorkState>;
	consolidation: ReviewWorkState;
	terminal: boolean;
	runDir: string;
};

type ArtifactResult = { status?: string };
type ArtifactWithResult = ReviewArtifact & { result?: ArtifactResult };

async function readJson<T>(filePath: string): Promise<T> {
	return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function readOptionalResult(runDir: string, artifact: ArtifactWithResult): Promise<ArtifactResult | undefined> {
	if (artifact.result) return artifact.result;
	try {
		return await readJson<ArtifactResult>(path.join(runDir, artifact.status));
	} catch (error) {
		if ((error instanceof Error && "code" in error && error.code === "ENOENT") || error instanceof SyntaxError) return undefined;
		throw error;
	}
}

function completedState(result: ArtifactResult | undefined): ReviewWorkState | undefined {
	if (result?.status === "complete") return "finished";
	if (result?.status === "timed_out") return "timed-out";
	if (result) return "failed";
	return undefined;
}

export async function readSkillReviewProgress(runDir: string): Promise<SkillReviewProgress> {
	const run = await readJson<SkillReviewRun>(path.join(runDir, "run.json"));
	const reviewerEntries = await Promise.all((Object.keys(run.reviewers) as Reviewer[]).map(async (reviewer) => {
		const state = completedState(await readOptionalResult(runDir, run.reviewers[reviewer] as ArtifactWithResult)) ?? "working";
		return [reviewer, state] as const;
	}));
	const reviewers = Object.fromEntries(reviewerEntries) as Record<Reviewer, ReviewWorkState>;
	const consolidatedResult = await readOptionalResult(runDir, run.consolidated as ArtifactWithResult);
	const consolidation = completedState(consolidatedResult)
		?? (run.status === "consolidating"
			? "working"
			: run.status === "running"
				? "waiting"
				: "not-run");
	const reviewersFinished = Object.values(reviewers).every((state) => state !== "working");
	const terminal = (run.status === "complete" || run.status === "partial")
		&& reviewersFinished
		&& consolidation !== "working"
		&& consolidation !== "waiting";

	return { skillName: run.skill.name, runStatus: run.status, reviewers, consolidation, terminal, runDir };
}

function stateLabel(state: ReviewWorkState): string {
	switch (state) {
		case "working": return "◌ working";
		case "finished": return "✓ finished";
		case "failed": return "✗ failed";
		case "timed-out": return "! timed out";
		case "waiting": return "… waiting for reviewers";
		case "not-run": return "— not run";
	}
}

export function formatSkillReviewProgress(progress: SkillReviewProgress): string[] {
	const outcome = progress.runStatus === "complete"
		? "complete"
		: progress.runStatus === "partial"
			? "partial"
			: progress.runStatus;
	return [
		`Skill review · ${progress.skillName} · ${outcome}`,
		...(["Pi", "Codex", "Claude"] as Reviewer[]).map((reviewer) => `${reviewer}: ${stateLabel(progress.reviewers[reviewer])}`),
		`Consolidation: ${stateLabel(progress.consolidation)}`,
	];
}
