import { randomBytes } from "node:crypto";
import { appendFile, chmod, copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResolvedSkillEvalConfig } from "./config.ts";
import { evidenceJson, failureRecord, structuredError } from "./failure.ts";
import type { ArtifactReference, MonitorEvent, NormalizedRunEvent, RunRecord } from "./types.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function timestampId(date = new Date()): string {
	return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "eval";
}

export function createRunId(name: string, date = new Date()): string {
	return `${timestampId(date)}-${slug(name)}-${randomBytes(4).toString("hex")}`;
}

export function artifact(pathname: string): ArtifactReference {
	return { path: pathname, completeness: "not_started" };
}

export class SkillEvalStorageError extends Error {
	constructor(readonly runDir: string, cause: unknown) {
		super(`Failed to initialize skill-eval evidence. Diagnostic directory: ${runDir}`, { cause });
		this.name = "SkillEvalStorageError";
	}
}

export class RunStorage {
	readonly runDir: string;
	readonly workspacesDir: string;
	readonly eventsPath: string;
	private writeQueue: Promise<void> = Promise.resolve();
	private lastEvent?: NormalizedRunEvent;

	private constructor(
		readonly record: RunRecord,
		runDir: string,
	) {
		this.runDir = runDir;
		this.workspacesDir = path.join(runDir, "workspaces");
		this.eventsPath = path.join(runDir, "events.jsonl");
	}

	static async create(baseDir: string, resolved: ResolvedSkillEvalConfig): Promise<RunStorage> {
		const runId = createRunId(resolved.config.name);
		const runDir = path.join(baseDir, runId);
		await mkdir(runDir, { recursive: false, mode: PRIVATE_DIRECTORY_MODE });

		const variants = Object.entries(resolved.config.variants).map(([id, variant]) => ({
			id,
			prompt: variant.prompt,
			status: "pending" as const,
			policyFindings: [],
			artifacts: {
				session: artifact(`variants/${id}/session`),
				transcript: artifact(`variants/${id}/transcript.md`),
				systemPrompt: artifact(`variants/${id}/system-prompt.md`),
				systemPrompts: artifact(`variants/${id}/system-prompts.jsonl`),
				toolCalls: artifact(`variants/${id}/tool-calls.jsonl`),
				finalResponse: artifact(`variants/${id}/final-response.md`),
				diff: artifact(`variants/${id}/diff.patch`),
				status: artifact(`variants/${id}/status.txt`),
				metrics: artifact(`variants/${id}/metrics.json`),
				resources: artifact(`variants/${id}/resources.json`),
			},
		}));
		const record: RunRecord = {
			artifactVersion: 1,
			runId,
			name: resolved.config.name,
			status: "preparing",
			phase: "initialize_storage",
			createdAt: new Date().toISOString(),
			configPath: resolved.configPath,
			variants,
			artifacts: {
				eval: artifact("eval.yaml"),
				reviewRubric: resolved.reviewRubric
					? artifact("review-rubric.yaml")
					: { path: "review-rubric.yaml", completeness: "unavailable" },
				resolvedConfig: artifact("resolved-config.json"),
				replacements: artifact("replacements.json"),
				removals: artifact("removals.json"),
				events: { path: "events.jsonl", completeness: "partial" },
				reportMarkdown: artifact("report.md"),
				reportHtml: artifact("report.html"),
				failure: artifact("failure.json"),
			},
		};

		const storage = new RunStorage(record, runDir);
		let eventsCreated = false;
		try {
			await mkdir(path.join(runDir, "variants"), { mode: PRIVATE_DIRECTORY_MODE });
			await mkdir(path.join(runDir, "workspaces"), { mode: PRIVATE_DIRECTORY_MODE });
			await copyFile(resolved.configPath, path.join(runDir, "eval.yaml"));
			await chmod(path.join(runDir, "eval.yaml"), PRIVATE_FILE_MODE);
			record.artifacts.eval.completeness = "complete";
			if (resolved.reviewRubric) {
				await copyFile(resolved.reviewRubric.rubricPath, path.join(runDir, "review-rubric.yaml"));
				await chmod(path.join(runDir, "review-rubric.yaml"), PRIVATE_FILE_MODE);
				record.artifacts.reviewRubric.completeness = "complete";
			}
			await writeFile(path.join(runDir, "resolved-config.json"), `${JSON.stringify({
				...resolved.config,
				configPath: resolved.configPath,
				workspacePath: resolved.workspacePath,
				replacements: resolved.replacements,
				removals: resolved.removals,
				reviewRubric: resolved.reviewRubric,
			}, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
			record.artifacts.resolvedConfig.completeness = "complete";
			await writeFile(storage.eventsPath, "", { mode: PRIVATE_FILE_MODE });
			eventsCreated = true;
			await storage.save();
			return storage;
		} catch (error) {
			record.status = "harness_error";
			if (!eventsCreated) record.artifacts.events.completeness = "unavailable";
			record.failurePhase = "initialize_storage";
			record.completedAt = new Date().toISOString();
			record.error = structuredError(error).message;
			record.errors = [structuredError(error)];
			await storage.writeFailure().catch(() => {});
			await storage.save().catch(() => {});
			throw new SkillEvalStorageError(runDir, error);
		}
	}

	variantDir(variantId: string): string {
		return path.join(this.runDir, "variants", variantId);
	}

	async prepareVariantDirectory(variantId: string): Promise<string> {
		const directory = this.variantDir(variantId);
		await mkdir(path.join(directory, "session"), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
		return directory;
	}

	getVariant(variantId: string) {
		const variant = this.record.variants.find((item) => item.id === variantId);
		if (!variant) throw new Error(`Unknown variant: ${variantId}`);
		return variant;
	}

	async writeFailure(): Promise<void> {
		this.record.artifacts.failure.completeness = "complete";
		try {
			await writeFile(path.join(this.runDir, this.record.artifacts.failure.path), `${JSON.stringify(failureRecord(this.record, this.lastEvent), null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
		} catch (error) {
			this.record.artifacts.failure.completeness = "partial";
			throw error;
		}
	}

	async save(): Promise<void> {
		const target = path.join(this.runDir, "run.json");
		const temporary = `${target}.tmp`;
		await writeFile(temporary, `${JSON.stringify(this.record, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
		await rename(temporary, target);
		await chmod(target, PRIVATE_FILE_MODE);
	}

	/** Serializing appends prevents concurrent SDK callbacks from interleaving JSONL bytes. */
	appendEvent(event: MonitorEvent): Promise<void> {
		const persisted: NormalizedRunEvent = {
			timestamp: event.timestamp,
			runId: event.runId,
			variantId: event.variantId,
			kind: event.kind,
			data: event.data,
		};
		this.lastEvent = persisted;
		this.writeQueue = this.writeQueue.then(() => appendFile(this.eventsPath, `${evidenceJson(persisted)}\n`, { mode: PRIVATE_FILE_MODE }));
		return this.writeQueue;
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}
}
