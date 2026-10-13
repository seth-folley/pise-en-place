import { describe, expect, it } from "vitest";
import { readAgentCompletionJson } from "../src/shared/agent-completion-json.ts";

const assistant = (stopReason = "stop", content: unknown = [{ type: "text", text: "Final response" }]) => ({ role: "assistant", stopReason, content });
const lines = (...events: unknown[]) => events.map(event => JSON.stringify(event)).join("\n");
const ended = (message = assistant()) => [
    { type: "agent_start" }, { type: "message_end", message }, { type: "agent_end", messages: [message] }, { type: "agent_settled", aborted: false },
];

describe("buffered completion JSON", () => {
    it("uses LF framing, preserves Unicode separators/all text blocks, and accepts CRLF/unterminated final records", () => {
        const message = assistant("stop", [{ type: "text", text: "One\u2028two\u2029three" }, { type: "thinking", thinking: "PRIVATE" }, { type: "text", text: "Four" }]);
        const result = readAgentCompletionJson(lines({ type: "session", id: "one" }, ...ended(message)).replaceAll("\n", "\r\n"));
        expect(result.valid).toBe(true);
        expect(result.completion.outcome()).toBe("completed");
        expect(result.completion.finalText).toBe("One\u2028two\u2029three\nFour");
    });
    it.each(["length", "error", "aborted", "toolUse", "deferred", "pending"])("preserves unsuccessful %s evidence even after zero exit", reason => {
        const result = readAgentCompletionJson(lines(...ended(assistant(reason))));
        expect(result.valid).toBe(true);
        expect(result.completion.outcome({ exitCode: 0 })).not.toBe("completed");
    });
    it("requires settlement and clears stale responses on an empty continuation", () => {
        const missing = readAgentCompletionJson(lines(...ended().slice(0, -1)));
        expect(missing.completion.outcome()).toBe("incomplete");
        const retry = readAgentCompletionJson(lines(...ended(), { type: "agent_start" }, { type: "agent_end", messages: [] }, { type: "agent_settled" }));
        expect(retry.completion.outcome()).toBe("incomplete");
        expect(retry.completion.finalText).toBe("");
    });
    it.each([
        null, [], { type: "agent_end", messages: {} }, { type: "message_end", message: { role: "assistant", content: {} } },
        { type: "message_end", message: assistant("stop", [{ type: "text", text: 5 }]) }, { type: "agent_settled", aborted: "false" },
    ])("marks malformed completion records invalid: %j", malformed => {
        expect(readAgentCompletionJson(lines(...ended(), malformed)).valid).toBe(false);
    });
    it("does not accept mixed text/protocol output as complete evidence", () => {
        expect(readAgentCompletionJson(`${lines(...ended())}\nPRIVATE unstructured diagnostic`).valid).toBe(false);
    });
    it("uses only the last assistant attempt after retries or a textless abort", () => {
        const result = readAgentCompletionJson(lines(...ended(assistant("error")), ...ended(assistant("stop"))));
        expect(result.completion.outcome()).toBe("completed");
        const aborted = readAgentCompletionJson(lines(...ended(), { type: "agent_start" }, ...ended(assistant("aborted", [])).slice(1)));
        expect(aborted.completion.outcome()).toBe("aborted");
        expect(aborted.completion.finalText).toBe("");
    });
});
