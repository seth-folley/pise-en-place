import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getGitUsageProjectAttribution, mergeUsageProjectAttribution, normalizeUsageTags, readUsageConfig, writeUsageConfig } from "../../../src/shared/usage-attribution.ts";
import type { ResolvedSkillEvalConfig } from "./config.ts";
import { createChildUI } from "./child-ui.ts";
import { structuredError } from "./failure.ts";
import { VariantRecorder } from "./recorder.ts";
import { RunStorage } from "./storage.ts";
import type { ExecutionPhase, ExecutionStatus, MonitorEvent, VariantMetrics } from "./types.ts";
import { applyRemovals, applyReplacements, captureDiff, copyWorkspace, establishBaseline } from "./workspace.ts";
import { generateReports } from "./report.ts";

/** A resumable deadline keeps human dialog latency out of the agent execution budget. */
class ActiveDeadline {
	private remainingMs: number;
	private activeStarted?: number;
	private hasStarted = false;
	private timer?: NodeJS.Timeout;
	private resolve!: () => void;
	readonly expired = new Promise<void>((resolve) => { this.resolve = resolve; });

	constructor(timeoutMs: number) {
		this.remainingMs = timeoutMs;
	}

	start(): void {
		if (this.activeStarted !== undefined) return;
		this.hasStarted = true;
		this.activeStarted = Date.now();
		this.timer = setTimeout(() => this.resolve(), this.remainingMs);
	}

	pause(): void {
		if (this.activeStarted === undefined) return;
		this.remainingMs -= Date.now() - this.activeStarted;
		this.activeStarted = undefined;
		if (this.timer) clearTimeout(this.timer);
	}

	resume(): void {
		if (!this.hasStarted || this.activeStarted !== undefined || this.remainingMs <= 0) return;
		this.start();
	}

	stop(): void {
		this.pause();
	}
}

export interface EvaluationRunResult {
	storage: RunStorage;
	status: ExecutionStatus;
}

export interface EvaluationRunOptions {
	baseDir?: string;
	parentUI: ExtensionUIContext;
	signal: AbortSignal;
	/** Test seam; production uses Pi's configured global agent directory. */
	agentDir?: string;
	onEvent(event: MonitorEvent): void;
}

function errorText(error: unknown): string {
	return structuredError(error).message;
}

function modelParts(value: string): [string, string] {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) throw new Error(`Model must use provider/model format: ${value}`);
	return [value.slice(0, slash), value.slice(slash + 1)];
}

function usageMetrics(session: Awaited<ReturnType<typeof createAgentSession>>["session"]): Omit<VariantMetrics, "wallTimeMs" | "activeTimeMs" | "dialogWaitMs" | "changedFiles" | "insertions" | "deletions"> {
	const stats = session.getSessionStats();
	let cost = 0;
	let costAvailable = false;
	let toolFailures = 0;
	for (const message of session.messages as unknown as Array<Record<string, unknown>>) {
		if (message.role === "assistant") {
			const total = ((message.usage as Record<string, unknown> | undefined)?.cost as Record<string, unknown> | undefined)?.total;
			if (typeof total === "number") { cost += total; costAvailable = true; }
		}
		if (message.role === "toolResult" && message.isError === true) toolFailures += 1;
	}
	return {
		inputTokens: stats.tokens.input,
		outputTokens: stats.tokens.output,
		cacheReadTokens: stats.tokens.cacheRead,
		cacheWriteTokens: stats.tokens.cacheWrite,
		cost: costAvailable ? cost : "unavailable",
		toolCalls: stats.toolCalls,
		toolFailures,
	};
}

async function runVariant(
	resolved: ResolvedSkillEvalConfig,
	storage: RunStorage,
	variantId: string,
	workspace: string,
	options: EvaluationRunOptions,
): Promise<ExecutionStatus> {
	const variant = storage.getVariant(variantId);
	const variantDir = await storage.prepareVariantDirectory(variantId);
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	const recorder = new VariantRecorder(
		storage,
		variantId,
		variantDir,
		options.onEvent,
		(name) => session?.getToolDefinition(name),
		() => session?.systemPrompt,
	);
	await recorder.initialize();
	const setPhase = (phase: ExecutionPhase): void => {
		variant.phase = phase;
		recorder.emit("variant_phase_changed", { phase });
	};
	const retainError = (error: unknown): void => {
		(variant.errors ??= []).push(structuredError(error));
	};
	variant.artifacts.toolCalls.completeness = "partial";
	variant.artifacts.systemPrompts.completeness = "partial";
	variant.status = "preparing";
	await storage.save();
	recorder.emit("variant_preparing");

	let status: ExecutionStatus = "harness_error";
	let dialogWaitMs = 0;
	let dialogDepth = 0;
	let dialogWaitStarted = 0;
	let promptAcceptedAt = 0;
	let settledAt = 0;
	let timedOut = false;
	let interactionBlocked = false;
	let cancelled = false;
	let policyViolation = false;
	let resourcesWritten = false;
	const deadline = new ActiveDeadline(resolved.config.limits.timeoutSeconds * 1000);
	const agentDir = options.agentDir ?? getAgentDir();

	const evaluatorExtension: ExtensionFactory = (pi) => {
		pi.on("tool_call", (event) => {
			const allowlist = resolved.config.agent.tools;
			if (!allowlist || allowlist.includes(event.toolName)) return;
			policyViolation = true;
			variant.failurePhase = "tool_policy";
			const detail = `Denied disallowed tool ${event.toolName}`;
			variant.policyFindings.push({ type: "tool_policy_violation", detail });
			recorder.emit("tool_policy_violation", { toolName: event.toolName, toolCallId: event.toolCallId, input: event.input });
			return { block: true, reason: detail };
		});
	};

	const settingsManager = SettingsManager.create(workspace, agentDir);
	const loader = new DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager, extensionFactories: [evaluatorExtension] });

	try {
		setPhase("load_resources");
		await loader.reload();
		setPhase("create_session");
		const modelRuntime = await ModelRuntime.create({
			authPath: path.join(agentDir, "auth.json"),
			modelsPath: path.join(agentDir, "models.json"),
		});
		const sessionManager = SessionManager.create(workspace, path.join(variantDir, "session"));
		const created = await createAgentSession({
			cwd: workspace,
			agentDir,
			modelRuntime,
			settingsManager,
			resourceLoader: loader,
			sessionManager,
			tools: resolved.config.agent.tools,
		});
		session = created.session;
		if (session.sessionFile) {
			variant.artifacts.session.path = path.relative(storage.runDir, session.sessionFile);
			variant.artifacts.session.completeness = "partial";
		}

		setPhase("bind_extensions");
		const childUI = createChildUI(options.parentUI, resolved.config.dialogs, {
			onRequest: (kind, detail) => recorder.emit("child_ui_requested", { kind, detail }),
			onResponse: (kind, result, waitMs) => recorder.emit("child_ui_resolved", { kind, result, waitMs }),
			onBlocked: (kind) => {
				interactionBlocked = true;
				recorder.emit("variant_interaction_blocked", { kind });
				void session?.abort();
			},
			onWaitStart: () => {
				if (dialogDepth++ === 0) { dialogWaitStarted = Date.now(); deadline.pause(); }
			},
			onWaitEnd: () => {
				if (dialogDepth > 0 && --dialogDepth === 0) {
					dialogWaitMs += Date.now() - dialogWaitStarted;
					deadline.resume();
				}
			},
		}, options.signal);
		await session.bindExtensions({
			uiContext: childUI,
			abortHandler: () => { void session?.abort(); },
			onError: (error) => recorder.emit("extension_error", error),
		});
		if (interactionBlocked) throw new Error("Child custom UI was blocked by the dialog policy");
		if (options.signal.aborted) throw options.signal.reason ?? new Error("Evaluation cancelled");

		setPhase("resolve_model");
		const [provider, modelId] = modelParts(resolved.config.agent.model);
		const model = session.modelRuntime.getModel(provider, modelId);
		if (!model) throw new Error(`Configured model is unavailable: ${resolved.config.agent.model}`);
		if (!session.model || session.model.provider !== provider || session.model.id !== modelId) await session.setModel(model);
		if (resolved.config.agent.thinking) session.setThinkingLevel(resolved.config.agent.thinking);
		setPhase("load_resources");
		await recorder.writeResources(session, loader);
		resourcesWritten = true;
		variant.artifacts.resources.completeness = "complete";

		variant.status = "running";
		variant.startedAt = new Date().toISOString();
		await storage.save();
		recorder.emit("variant_started", { model: resolved.config.agent.model, thinking: session.thinkingLevel, tools: session.getActiveToolNames(), workspace });
		const unsubscribe = session.subscribe((event) => recorder.recordSdkEvent(event));
		const abortListener = () => { cancelled = true; void session?.abort(); };
		if (options.signal.aborted) abortListener();
		else options.signal.addEventListener("abort", abortListener, { once: true });
		try {
			setPhase("prompt");
			if (cancelled) throw options.signal.reason ?? new Error("Evaluation cancelled");
			const promptPromise = session.prompt(variant.prompt, {
				expandPromptTemplates: false,
				source: "interactive",
				preflightResult: (accepted) => {
					if (!accepted) return;
					promptAcceptedAt = Date.now();
					deadline.start();
				},
			});
			const outcome = await Promise.race([
				promptPromise.then(() => "settled" as const),
				deadline.expired.then(() => "timeout" as const),
			]);
			if (outcome === "timeout") {
				timedOut = true;
				recorder.emit("variant_timed_out", { timeoutSeconds: resolved.config.limits.timeoutSeconds });
				await session.abort();
				await promptPromise.catch(() => {});
			}
			settledAt = Date.now();
		} finally {
			options.signal.removeEventListener("abort", abortListener);
			unsubscribe();
			deadline.stop();
		}

		status = interactionBlocked ? "interaction_blocked" : cancelled ? "cancelled" : timedOut ? "timed_out" : "completed";
		if (status !== "completed") variant.failurePhase ??= variant.phase;
		if (policyViolation) recorder.emit("variant_completed", { policyFindings: variant.policyFindings.length });
		else recorder.emit(status === "completed" ? "variant_completed" : `variant_${status}`);
	} catch (error) {
		status = interactionBlocked ? "interaction_blocked" : cancelled || options.signal.aborted ? "cancelled" : timedOut ? "timed_out" : "harness_error";
		variant.failurePhase ??= variant.phase;
		variant.error = errorText(error);
		retainError(error);
		recorder.emit(status === "harness_error" ? "variant_harness_error" : `variant_${status}`, { error: variant.error });
	} finally {
		let diff = { status: "", patch: "", changedFiles: 0, insertions: 0, deletions: 0 };
		try {
			setPhase("capture_git_evidence");
			diff = await captureDiff(workspace, storage.record.baselineSha ?? "HEAD");
			await writeFile(path.join(variantDir, "status.txt"), diff.status, { mode: 0o600 });
			await writeFile(path.join(variantDir, "diff.patch"), diff.patch, { mode: 0o600 });
			for (const key of ["status", "diff"] as const) variant.artifacts[key].completeness = "complete";
			recorder.emit("diff_captured", diff);
		} catch (error) {
			variant.error = [variant.error, `Git evidence: ${errorText(error)}`].filter(Boolean).join("\n");
			retainError(error);
			if (status === "completed") { status = "harness_error"; variant.failurePhase = "capture_git_evidence"; }
		}

		const usage = session ? usageMetrics(session) : {
			inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
			cost: "unavailable" as const, toolCalls: 0, toolFailures: 0,
		};
		const wallTimeMs = promptAcceptedAt ? (settledAt || Date.now()) - promptAcceptedAt : 0;
		const metrics: VariantMetrics = {
			...usage,
			wallTimeMs,
			activeTimeMs: Math.max(0, wallTimeMs - dialogWaitMs),
			dialogWaitMs,
			changedFiles: diff.changedFiles,
			insertions: diff.insertions,
			deletions: diff.deletions,
		};
		variant.metrics = metrics;
		if (session) {
			try {
				setPhase("capture_session_evidence");
				await recorder.finalizeSession(session, metrics);
				if (session.sessionFile) await chmod(session.sessionFile, 0o600);
				for (const key of ["session", "transcript", "systemPrompts", "toolCalls", "finalResponse", "metrics"] as const) {
					variant.artifacts[key].completeness = "complete";
				}
				variant.artifacts.systemPrompt.completeness = recorder.hasSystemPrompt ? "complete" : "unavailable";
			} catch (error) {
				variant.error = [variant.error, `Session evidence: ${errorText(error)}`].filter(Boolean).join("\n");
				retainError(error);
				if (status === "completed") { status = "harness_error"; variant.failurePhase = "capture_session_evidence"; }
			}
		}
		if (!resourcesWritten && variant.artifacts.resources.completeness === "not_started") {
			variant.artifacts.resources.completeness = "unavailable";
		}
		variant.status = status;
		if (status !== "completed") variant.failurePhase ??= variant.phase;
		setPhase("teardown");
		variant.completedAt = new Date().toISOString();
		await storage.flush();
		await storage.save();
		session?.dispose();
		await rm(workspace, { recursive: true, force: true });
		setPhase("settled");
		await storage.save();
	}
	return policyViolation && status === "completed" ? "completed" : status;
}

export async function runEvaluation(resolved: ResolvedSkillEvalConfig, options: EvaluationRunOptions): Promise<EvaluationRunResult> {
	const baseDir = options.baseDir ?? path.join(options.agentDir ?? getAgentDir(), "skill-evals");
	await mkdir(baseDir, { recursive: true, mode: 0o700 });
	const storage = await RunStorage.create(baseDir, resolved);
	const emit = (kind: string, data?: unknown): void => {
		const event = { timestamp: new Date().toISOString(), runId: storage.record.runId, kind, data };
		void storage.appendEvent(event);
		options.onEvent(event);
	};
	const setRunPhase = (phase: ExecutionPhase): void => {
		storage.record.phase = phase;
		emit("run_phase_changed", { phase });
	};
	const retainRunError = (error: unknown): void => {
		(storage.record.errors ??= []).push(structuredError(error));
	};
	const persistFailure = async (): Promise<void> => {
		try {
			await storage.writeFailure();
		} catch (error) {
			storage.record.error = [storage.record.error, `Failure evidence: ${errorText(error)}`].filter(Boolean).join("\n");
			retainRunError(error);
		}
	};
	const prepared = path.join(storage.workspacesDir, "prepared");

	try {
		emit("run_started", { name: resolved.config.name });
		const gitAttribution = await getGitUsageProjectAttribution(resolved.workspacePath);
		let usageConfig = null;
		try {
			usageConfig = await readUsageConfig(resolved.workspacePath);
		} catch (error) {
			emit("usage_attribution_config_ignored", { error: errorText(error) });
		}
		const usageAttribution = mergeUsageProjectAttribution(gitAttribution, usageConfig?.project ?? null);
		const usageTags = normalizeUsageTags([...(usageConfig?.tags ?? []), "skill-eval"]);
		setRunPhase("copy_workspace");
		emit("workspace_copy_started", { source: resolved.workspacePath });
		await copyWorkspace(resolved.workspacePath, prepared, options.signal);
		emit("workspace_copy_completed");
		setRunPhase("apply_replacements");
		const replacements = await applyReplacements(resolved, prepared, options.signal);
		await writeFile(path.join(storage.runDir, "replacements.json"), `${JSON.stringify(replacements, null, 2)}\n`, { mode: 0o600 });
		storage.record.artifacts.replacements.completeness = "complete";
		for (const replacement of replacements) emit("replacement_applied", replacement);
		const removals = await applyRemovals(resolved, prepared, options.signal);
		await writeFile(path.join(storage.runDir, "removals.json"), `${JSON.stringify(removals, null, 2)}\n`, { mode: 0o600 });
		storage.record.artifacts.removals.completeness = "complete";
		for (const removal of removals) emit("removal_applied", removal);
		await writeUsageConfig(prepared, { project: usageAttribution, tags: usageTags });
		if (usageAttribution.gitRemote || usageAttribution.gitBranch || usageTags.length) {
			emit("usage_attribution_prepared", { ...usageAttribution, tags: usageTags });
		}
		setRunPhase("establish_baseline");
		storage.record.baselineSha = await establishBaseline(prepared, options.signal);
		emit("baseline_created", { sha: storage.record.baselineSha });
		await storage.save();

		storage.record.status = "running";
		for (const variant of storage.record.variants) {
			let attempt = 0;
			let status: ExecutionStatus = "harness_error";
			do {
				setRunPhase("prepare_variant");
				if (options.signal.aborted) {
					storage.record.status = "cancelled";
					storage.record.failurePhase = "prepare_variant";
					break;
				}
				attempt += 1;
				const workspace = path.join(storage.workspacesDir, variant.id);
				await copyWorkspace(prepared, workspace, options.signal);
				status = await runVariant(resolved, storage, variant.id, workspace, options);
				if (status !== "timed_out" || variant.policyFindings.length > 0 || resolved.config.limits.onTimeout !== "retry" || attempt > resolved.config.limits.maxRetries) break;
				const archivedAttempt = path.join(storage.runDir, "variants", `${variant.id}.attempt-${attempt}`);
				await rename(storage.variantDir(variant.id), archivedAttempt);
				emit("variant_timeout_retrying", { variantId: variant.id, attempt, maxRetries: resolved.config.limits.maxRetries });
			} while (true);

			if (storage.record.status !== "running") break;
			if (status === "timed_out" && resolved.config.limits.onTimeout === "continue") {
				emit("variant_timeout_continued", { variantId: variant.id });
				continue;
			}
			if (status !== "completed" || variant.policyFindings.length > 0) {
				storage.record.status = variant.policyFindings.length > 0 && status === "completed" ? "policy_stopped" : status;
				storage.record.failurePhase = variant.failurePhase ?? variant.phase ?? "prepare_variant";
				break;
			}
		}
		if (storage.record.status === "running") storage.record.status = "completed";
	} catch (error) {
		storage.record.status = options.signal.aborted ? "cancelled" : "harness_error";
		storage.record.failurePhase ??= storage.record.phase;
		storage.record.error = errorText(error);
		retainRunError(error);
		emit(storage.record.status === "cancelled" ? "run_cancelled" : "run_harness_error", { error: storage.record.error });
	} finally {
		storage.record.completedAt = new Date().toISOString();
		if (storage.record.status !== "completed") await persistFailure();
		await storage.save();
		try {
			if (storage.record.status === "completed") setRunPhase("generate_report");
			emit("report_started");
			await storage.flush();
			await generateReports(storage.runDir);
			storage.record.artifacts.reportMarkdown.completeness = "complete";
			storage.record.artifacts.reportHtml.completeness = "complete";
			emit("report_completed");
		} catch (error) {
			storage.record.error = [storage.record.error, `Report generation: ${errorText(error)}`].filter(Boolean).join("\n");
			retainRunError(error);
			if (storage.record.status === "completed") {
				storage.record.status = "harness_error";
				storage.record.failurePhase = "generate_report";
			}
		}
		await rm(storage.workspacesDir, { recursive: true, force: true });
		storage.record.phase = "settled";
		emit(storage.record.status === "completed" ? "run_completed" : "run_stopped", { status: storage.record.status, failurePhase: storage.record.failurePhase });
		await storage.flush();
		storage.record.artifacts.events.completeness = "complete";
		if (storage.record.status !== "completed") await persistFailure();
		else storage.record.artifacts.failure.completeness = "unavailable";
		await storage.save();
	}
	return { storage, status: storage.record.status };
}
