const completionOutcomes = ["completed", "aborted", "error", "truncated", "incomplete"] as const;
export type AgentCompletionOutcome = typeof completionOutcomes[number];

export function isAgentCompletionOutcome(value: unknown): value is AgentCompletionOutcome {
    return typeof value === "string" && completionOutcomes.includes(value as AgentCompletionOutcome);
}

export interface CompletionMessage {
    role: string;
    stopReason?: string;
    errorMessage?: string;
    content?: string | readonly { type: string; text?: string }[];
}

export interface CompletionEvent {
    type: string;
    message?: CompletionMessage;
    messages?: readonly CompletionMessage[];
    /** Optional for Pi versions predating the explicit settlement abort flag. */
    aborted?: boolean;
}

export function classifyAgentCompletion(evidence: {
    settled: boolean;
    stopReason?: string;
    aborted?: boolean;
    exitCode?: number;
}): AgentCompletionOutcome {
    if (evidence.aborted || evidence.stopReason === "aborted") return "aborted";
    if (evidence.exitCode !== undefined && evidence.exitCode !== 0) return "error";
    if (!evidence.settled) return "incomplete";
    switch (evidence.stopReason) {
        case "stop": return "completed";
        case "error": return "error";
        case "length": return "truncated";
        default: return "incomplete";
    }
}

/** Track finalized evidence, not streamed text or the resolution of prompt()/process exit. */
export class AgentCompletionTracker {
    private settled = false;
    private settledAborted?: boolean;
    private assistant?: CompletionMessage;

    observe(event: CompletionEvent): void {
        if (event.type === "agent_start") {
            // A retry or queued continuation must not inherit an earlier successful response.
            this.settled = false;
            this.settledAborted = undefined;
            this.assistant = undefined;
        } else if (event.type === "message_end" && event.message?.role === "assistant") {
            this.assistant = event.message;
        } else if (event.type === "agent_end") {
            this.assistant = [...(event.messages ?? [])].reverse().find(message => message.role === "assistant");
        } else if (event.type === "agent_settled") {
            this.settled = true;
            this.settledAborted = event.aborted;
        }
    }

    get stopReason(): string | undefined { return this.assistant?.stopReason; }
    get errorMessage(): string | undefined { return this.assistant?.errorMessage; }
    get finalText(): string {
        const content = this.assistant?.content;
        if (typeof content === "string") return content;
        return content?.filter(part => part.type === "text").map(part => part.text ?? "").join("\n") ?? "";
    }

    outcome(options: { aborted?: boolean; exitCode?: number } = {}): AgentCompletionOutcome {
        return classifyAgentCompletion({
            settled: this.settled,
            stopReason: this.stopReason,
            // Explicit local cancellation always wins. The current settlement flag supersedes
            // a low-level attempt's abort signal (which may have been followed by recovery).
            aborted: options.aborted || this.settledAborted,
            exitCode: options.exitCode,
        });
    }

    description(outcome = this.outcome()): string {
        switch (outcome) {
            case "completed": return "Agent completed normally.";
            case "aborted": return "Agent run was aborted.";
            case "error": return this.errorMessage || "Agent run failed.";
            case "truncated": return "Agent response was truncated at the output-token limit.";
            case "incomplete": return this.settled
                ? `Agent settled without a successful final response (stop reason: ${this.stopReason ?? "missing"}).`
                : "Agent ended without settlement evidence.";
        }
    }
}
