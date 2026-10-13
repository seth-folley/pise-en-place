import { classifyAgentCompletion, type AgentCompletionOutcome } from "../../../src/shared/agent-completion.ts";

export interface SubagentCompletion {
    exitCode: number;
    stopReason?: string;
    outcome?: AgentCompletionOutcome;
}

/** New links retain the authoritative outcome; legacy links can only use exit/stop evidence. */
export function subagentOutcome(result: SubagentCompletion): AgentCompletionOutcome {
    if (result.exitCode !== 0) return result.outcome === "aborted" ? "aborted" : "error";
    return result.outcome ?? classifyAgentCompletion({ settled: true, stopReason: result.stopReason });
}

export function subagentOutcomeLabel(result: SubagentCompletion): string {
    const outcome = subagentOutcome(result);
    return outcome === "error" ? "failed" : outcome;
}

/** Keep the failure reason visible even when the final attempt produced partial text. */
export function subagentResultText(result: SubagentCompletion & { output?: string; stderr?: string }): string {
    const diagnostic = subagentOutcome(result) !== "completed" && result.stderr ? `Diagnostics:\n${result.stderr}` : undefined;
    return [diagnostic, result.output].filter(Boolean).join("\n\n") || result.stderr || "(no response)";
}
