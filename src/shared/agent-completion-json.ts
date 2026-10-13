import { AgentCompletionTracker, type CompletionEvent, type CompletionMessage } from "./agent-completion.ts";

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function message(value: unknown): value is CompletionMessage {
    if (!object(value) || typeof value.role !== "string") return false;
    if (value.role !== "assistant") return true;
    if (value.stopReason !== undefined && typeof value.stopReason !== "string") return false;
    if (value.errorMessage !== undefined && typeof value.errorMessage !== "string") return false;
    if (value.content === undefined || typeof value.content === "string") return true;
    return Array.isArray(value.content) && value.content.every(part => object(part) && typeof part.type === "string"
        && (part.type !== "text" || typeof part.text === "string"));
}
function event(value: unknown): value is CompletionEvent {
    if (!object(value) || typeof value.type !== "string") return false;
    if (value.type === "message_end") return message(value.message);
    if (value.type === "agent_end") return Array.isArray(value.messages) && value.messages.every(message);
    if (value.type === "agent_settled") return value.aborted === undefined || typeof value.aborted === "boolean";
    return true; // Headers/progress and future events do not affect completion.
}

/** Parse buffered JSONL without exposing tool/context payloads or inferring success from an exit code. */
export function readAgentCompletionJson(stdout: string): { completion: AgentCompletionTracker; valid: boolean } {
    const completion = new AgentCompletionTracker();
    let valid = true;
    // LF only: Unicode line/paragraph separators can occur inside JSON strings.
    for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
            const parsed: unknown = JSON.parse(line);
            if (!event(parsed)) { valid = false; continue; }
            completion.observe(parsed);
        } catch { valid = false; }
    }
    return { completion, valid };
}
