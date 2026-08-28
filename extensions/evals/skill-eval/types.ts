import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";

export type ExecutionStatus =
	| "pending"
	| "preparing"
	| "running"
	| "completed"
	| "timed_out"
	| "interaction_blocked"
	| "policy_stopped"
	| "cancelled"
	| "harness_error";

export type ArtifactCompleteness = "not_started" | "partial" | "complete" | "unavailable";

export type ExecutionPhase =
	| "initialize_storage"
	| "copy_workspace"
	| "apply_replacements"
	| "establish_baseline"
	| "prepare_variant"
	| "create_session"
	| "bind_extensions"
	| "resolve_model"
	| "load_resources"
	| "prompt"
	| "tool_policy"
	| "capture_git_evidence"
	| "capture_session_evidence"
	| "teardown"
	| "generate_report"
	| "settled";

export interface StructuredError {
	name: string;
	message: string;
	stack?: string;
	code?: string | number;
	signal?: string;
	stdout?: string;
	stderr?: string;
	cause?: StructuredError;
}

export interface ArtifactReference {
	path: string;
	completeness: ArtifactCompleteness;
}

export interface VariantMetrics {
	wallTimeMs: number;
	activeTimeMs: number;
	dialogWaitMs: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost: number | "unavailable";
	toolCalls: number;
	toolFailures: number;
	changedFiles: number;
	insertions: number;
	deletions: number;
}

export interface VariantRecord {
	id: string;
	prompt: string;
	status: ExecutionStatus;
	phase?: ExecutionPhase;
	failurePhase?: ExecutionPhase;
	startedAt?: string;
	completedAt?: string;
	error?: string;
	errors?: StructuredError[];
	policyFindings: Array<{ type: string; detail: string }>;
	artifacts: Record<string, ArtifactReference>;
	metrics?: VariantMetrics;
}

export interface RunRecord {
	artifactVersion: 1;
	runId: string;
	name: string;
	status: ExecutionStatus;
	phase?: ExecutionPhase;
	failurePhase?: ExecutionPhase;
	createdAt: string;
	completedAt?: string;
	configPath: string;
	baselineSha?: string;
	error?: string;
	errors?: StructuredError[];
	variants: VariantRecord[];
	artifacts: Record<string, ArtifactReference>;
}

export interface NormalizedRunEvent {
	timestamp: string;
	runId: string;
	variantId?: string;
	kind: string;
	data?: unknown;
}

/** Raw SDK events stay in memory only for native rendering; canonical finalized data lives in the Pi session. */
export interface MonitorEvent extends NormalizedRunEvent {
	sdkEvent?: AgentSessionEvent;
	toolDefinition?: ToolDefinition;
}
