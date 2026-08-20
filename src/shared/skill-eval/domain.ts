import path from "node:path";

export const SCHEMA_VERSION = 1 as const;
export const RUNNER_VERSION = "1.0.0-m1";
export const RUNNER_TIMEOUTS = { setup: 15 * 60_000, scenario: 20 * 60_000, check: 10 * 60_000 } as const;
export const ARTIFACT_LIMITS = { traceBytes: 16 * 1024 * 1024, diffBytes: 32 * 1024 * 1024 } as const;
export const SUPPORTED_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
export const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export type Arm = "control" | "baseline" | "candidate";
export type Severity = "critical" | "advisory";
export type Lifecycle = "preparing" | "running" | "pause_requested" | "paused" | "cancelling" | "completed" | "cancelled" | "interrupted";
export type Verdict = "pending" | "pass" | "fail" | "incomplete" | "informational";
export type CellStatus = "pending" | "running" | "passed" | "failed" | "errored" | "not_run" | "cancelled";
export type CheckStatus = "passed" | "failed" | "errored";

export interface Permissions { mode: "read-only" | "workspace-write"; network: boolean }
export interface Limits { scenarioTimeout: number; setupTimeout: number; checkTimeout: number }
export interface Target { harness: "pi" | "codex" | "claude-code"; model: string; thinking: string }
export interface Profile { repetitions: number; maxConcurrency: number; targets: Target[]; limits?: { maxCost?: number } }
export interface FixtureSetup { command?: string; script?: string; network: boolean }
export interface Fixture { type: "local" | "git"; path?: string; repository?: string; ref?: string; setup?: FixtureSetup }
export interface CheckSpec { id: string; type: "command" | "file-exists" | "file-contains" | "git-diff" | "trace-command"; severity: Severity; command?: string; path?: string; expect: Record<string, unknown> }
export interface Scenario { id: string; title: string; covers: string[]; purpose: string; prompt: string; fixture: Fixture; invocation: "explicit" | "implicit" | "contextual" | "forbidden"; runOn: Arm[]; tools: string[]; permissions: Permissions; limits: Limits; checks: CheckSpec[]; rubric: Array<{ id: string; description: string; weight: number }> }
export interface Suite { schemaVersion: 1; kind: "skill-eval-suite"; name: string; file: string; skill: { name: string; source: { type: "git"; repository: string }; path: string }; defaults: { tools: string[]; permissions: Permissions; limits: Limits }; profiles: Record<string, Profile>; scenarios: Scenario[] }

export type AcceptanceRule =
	| { id: string; type: "required-cell-completeness" }
	| { id: string; type: "all-candidate-critical-checks-pass" }
	| { id: string; type: "no-critical-regressions" }
	| { id: string; type: "candidate-pass-rate"; scope: Scope; minimum: number }
	| { id: string; type: "pass-rate-delta"; compareTo: "baseline" | "control"; scope: Scope; minimum: number }
	| { id: string; type: "median-cost-increase" | "median-duration-increase"; compareTo: "baseline" | "control"; scope: Scope; maximum: number };
export type Scope = "overall" | "eachScenario" | "eachTarget";
export interface Comparison { schemaVersion: 1; kind: "skill-eval-comparison"; name: string; file: string; suite: string; arms: { control: { skill: "disabled" }; baseline: { ref: string }; candidate: { ref?: string; snapshot?: { path: string } } }; change: { summary: string; changelog?: string }; hypotheses: Array<{ id: string; expectedChange: string; mustNotRegress: string[]; scenarios: string[] }>; nonGoals: string[]; execution: { profile: string; scenarios: { include?: string[]; all?: true } }; acceptance: { mode: "exploratory" | "gated"; rules: AcceptanceRule[] } }

export interface FileManifestEntry { path: string; size: number; sha256: string }
export interface FrozenInput { source: string; artifact: string; digest: string; files: FileManifestEntry[]; git?: { head?: string; dirty?: boolean } }
export interface ResolvedCell { id: string; blockId: string; scenarioId: string; arm: Arm; target: Target; repetition: number; order: number; workspace: string; skillArtifact?: string }
export interface ResolvedBlock { id: string; scenarioId: string; target: Target; repetition: number; order: number; cells: ResolvedCell[] }
export interface ResolvedScenario extends Omit<Scenario, "prompt"> { promptArtifact: string; fixtureArtifact: string; fixtureManifestArtifact: string; fixtureDigest: string; contextArtifact?: string }
export interface ResolvedPlan { schemaVersion: 1; runnerVersion: string; harnessVersions: { pi: string }; runId: string; createdAt: string; comparisonName: string; comparisonFile: string; suiteFile: string; profileName: string; profileOverridden: boolean; seed: string; isolationLevel: "best-effort"; warnings: string[]; skill: { name: string; control: { disabled: true }; baseline: FrozenInput; candidate: FrozenInput; diffArtifact: string }; scenarios: ResolvedScenario[]; profile: Profile; acceptance: Comparison["acceptance"]; hypotheses: Comparison["hypotheses"]; blocks: ResolvedBlock[] }

export interface Usage { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; cost?: number }
export interface CheckResult { id: string; type: CheckSpec["type"]; severity: Severity; status: CheckStatus; message: string; durationMs: number; artifact?: string }
export interface CellState { id: string; blockId: string; scenarioId: string; arm: Arm; target: string; repetition: number; status: CellStatus; startedAt?: string; endedAt?: string; durationMs?: number; usage?: Usage; checks: CheckResult[]; traceArtifact?: string; diffArtifact?: string; error?: string; lastTool?: string; isolationLevel: "best-effort" }
export interface RuleResult { id: string; type: string; status: "passed" | "failed" | "not_evaluated"; buckets: Array<{ key: string; status: "passed" | "failed" | "not_evaluated"; observed?: number; threshold?: number; reason?: string }> }
export interface RunState { schemaVersion: 1; runId: string; name: string; lifecycle: Lifecycle; verdict: Verdict; createdAt: string; updatedAt: string; startedAt?: string; endedAt?: string; sequence: number; profile: string; isolationLevel: "best-effort"; blocks: Record<string, { id: string; status: "pending" | "running" | "completed"; cellIds: string[] }>; cells: Record<string, CellState>; activeBlockId?: string; completedBlocks: number; completedCells: number; totalBlocks: number; totalCells: number; evaluationCost: number; acceptance: RuleResult[]; warnings: string[]; lastError?: string }
export interface RunEvent { schemaVersion: 1; sequence: number; eventId: string; runId: string; timestamp: string; type: string; data: Record<string, unknown> }
export interface ControllerInfo { pid: number; workerVersion: string; startedAt: string; heartbeatAt: string; childPids: number[] }
export interface RegistryEntry { runId: string; name: string; directory: string; lifecycle: Lifecycle; verdict: Verdict; createdAt: string; updatedAt: string }
export interface Registry { schemaVersion: 1; activeRunId?: string; runs: RegistryEntry[] }
export interface ControlRequest { schemaVersion: 1; id: string; runId: string; action: "pause" | "resume" | "cancel"; requestedAt: string }

export class ValidationError extends Error {
	constructor(public readonly issues: string[]) { super(issues.join("\n")); this.name = "ValidationError"; }
}

export function targetKey(target: Target): string { return `${target.harness}:${target.model}:${target.thinking}`; }
export function relativeArtifact(runDir: string, absolutePath: string): string { return path.relative(runDir, absolutePath).split(path.sep).join("/"); }
