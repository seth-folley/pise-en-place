import type { NormalizedRunEvent, RunRecord, StructuredError, VariantRecord } from "./types.ts";

function property(error: Record<string, unknown>, name: string): string | undefined {
	const value = error[name];
	if (typeof value === "string") return value;
	if (Buffer.isBuffer(value)) return value.toString("utf8");
	return value === undefined ? undefined : String(value);
}

/** Preserve useful non-enumerable Error fields and subprocess diagnostics in canonical evidence. */
export function structuredError(error: unknown, depth = 0): StructuredError {
	if (error instanceof Error || (error && typeof error === "object")) {
		const value = error as Error & Record<string, unknown>;
		const result: StructuredError = {
			name: typeof value.name === "string" && value.name ? value.name : "Error",
			message: typeof value.message === "string" && value.message ? value.message : String(error),
		};
		if (typeof value.stack === "string") result.stack = value.stack;
		if (typeof value.code === "string" || typeof value.code === "number") result.code = value.code;
		const signal = property(value, "signal");
		const stdout = property(value, "stdout");
		const stderr = property(value, "stderr");
		if (signal) result.signal = signal;
		if (stdout !== undefined) result.stdout = stdout;
		if (stderr !== undefined) result.stderr = stderr;
		if (value.cause !== undefined && depth < 8) result.cause = structuredError(value.cause, depth + 1);
		return result;
	}
	return { name: "Error", message: typeof error === "string" ? error : String(error) };
}

export function evidenceJson(value: unknown): string {
	const seen = new WeakSet<object>();
	return JSON.stringify(value, (_key, item: unknown) => {
		if (typeof item === "bigint") return item.toString();
		if (item instanceof Error) return structuredError(item);
		if (item && typeof item === "object") {
			if (seen.has(item)) return "[Circular]";
			seen.add(item);
		}
		return item;
	});
}

function variantFailure(variant: VariantRecord) {
	return {
		id: variant.id,
		status: variant.status,
		phase: variant.phase,
		failurePhase: variant.failurePhase,
		error: variant.error,
		errors: variant.errors ?? [],
		policyFindings: variant.policyFindings,
		artifacts: variant.artifacts,
	};
}

export function failureHints(run: RunRecord): string[] {
	switch (run.failurePhase) {
		case "initialize_storage": return ["Check evidence-directory permissions, available disk space, and the retained eval path."];
		case "copy_workspace": return ["Check workspace readability, symlink targets, and the copy error's path or code."];
		case "apply_replacements": return ["Check replacement sources, removal targets, target containment, directory targets, and parent symlink diagnostics."];
		case "establish_baseline": return ["Inspect Git exit details and verify the copied workspace can be initialized and committed."];
		case "load_resources": return ["Inspect extension and skill diagnostics in resources.json or events.jsonl when available."];
		case "create_session":
		case "bind_extensions": return ["Inspect extension errors, session storage permissions, and resource-loading diagnostics."];
		case "resolve_model": return ["Verify the configured provider/model exists and that authentication is available to Pi."];
		case "prompt": return ["Inspect provider retries, child-dialog events, tool evidence, and the native Pi session."];
		case "tool_policy": return ["Inspect policy findings and the denied tool-call event before changing the allowlist."];
		case "capture_git_evidence":
		case "capture_session_evidence": return ["The agent may have finished; inspect complete artifacts and the structured capture error separately."];
		case "generate_report": return ["Canonical evidence may still be complete; inspect failure.json and regenerate the derived report after fixing the renderer."];
		default: return ["Start with the structured error list and the last retained lifecycle event."];
	}
}

export function failureSummary(run: RunRecord): string {
	const phase = run.failurePhase ? ` during ${run.failurePhase.replaceAll("_", " ")}` : "";
	switch (run.status) {
		case "timed_out": return `Evaluation timed out${phase}.`;
		case "interaction_blocked": return `Evaluation stopped at a blocked interaction${phase}.`;
		case "policy_stopped": return `Evaluation stopped after a tool-policy finding${phase}.`;
		case "cancelled": return `Evaluation was cancelled${phase}.`;
		case "harness_error": return `Evaluation harness failed${phase}.`;
		default: return `Evaluation stopped with status ${run.status}${phase}.`;
	}
}

export function failureRecord(run: RunRecord, lastEvent?: NormalizedRunEvent) {
	return {
		artifactVersion: 1,
		generatedAt: new Date().toISOString(),
		summary: failureSummary(run),
		diagnosticHints: failureHints(run),
		run: {
			id: run.runId,
			name: run.name,
			status: run.status,
			phase: run.phase,
			failurePhase: run.failurePhase,
			error: run.error,
			errors: run.errors ?? [],
		},
		activeVariant: run.variants.find((variant) => variant.status !== "pending" && (variant.status !== "completed" || variant.policyFindings.length > 0))?.id
			?? [...run.variants].reverse().find((variant) => variant.status !== "pending")?.id,
		variants: run.variants.map(variantFailure),
		lastEvent,
		artifacts: run.artifacts,
	};
}
