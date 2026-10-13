import { describe, expect, it } from "vitest";
import { AgentCompletionTracker, classifyAgentCompletion } from "../src/shared/agent-completion.ts";

describe("authoritative agent completion", () => {
    it.each([
        ["stop", "completed"], ["error", "error"], ["length", "truncated"],
        ["aborted", "aborted"], ["toolUse", "incomplete"], ["deferred", "incomplete"],
        ["pending", "incomplete"], [undefined, "incomplete"],
    ])("classifies settled stop reason %s as %s", (stopReason, outcome) => {
        expect(classifyAgentCompletion({ settled: true, stopReason })).toBe(outcome);
    });

    it("requires settlement and lets explicit cancellation or process failure override success", () => {
        expect(classifyAgentCompletion({ settled: false, stopReason: "stop", exitCode: 0 })).toBe("incomplete");
        expect(classifyAgentCompletion({ settled: true, stopReason: "stop", aborted: true })).toBe("aborted");
        expect(classifyAgentCompletion({ settled: true, stopReason: "stop", exitCode: 1 })).toBe("error");
    });

    it("supports settlement events without an abort field on older Pi versions", () => {
        const tracker = new AgentCompletionTracker();
        tracker.observe({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        tracker.observe({ type: "agent_settled" });
        expect(tracker.outcome()).toBe("completed");
    });

    it("keeps the final attempt authoritative after automatic retries", () => {
        const tracker = new AgentCompletionTracker();
        tracker.observe({ type: "agent_start" });
        tracker.observe({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "busy" }] });
        tracker.observe({ type: "agent_start" });
        tracker.observe({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
        tracker.observe({ type: "agent_settled", aborted: false });
        expect(tracker.outcome()).toBe("completed");
        expect(tracker.errorMessage).toBeUndefined();
    });

    it("does not reuse prior success when a continuation produces no assistant response", () => {
        const tracker = new AgentCompletionTracker();
        tracker.observe({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        tracker.observe({ type: "agent_settled", aborted: false });
        tracker.observe({ type: "agent_start" });
        tracker.observe({ type: "agent_end", messages: [] });
        tracker.observe({ type: "agent_settled", aborted: false });
        expect(tracker.outcome()).toBe("incomplete");
    });

    it("recognizes aborts before the first assistant message", () => {
        const tracker = new AgentCompletionTracker();
        tracker.observe({ type: "agent_settled", aborted: true });
        expect(tracker.outcome()).toBe("aborted");
    });

    it("retains a textless provider error rather than falling back to an earlier message", () => {
        const tracker = new AgentCompletionTracker();
        tracker.observe({ type: "agent_start" });
        tracker.observe({ type: "message_end", message: { role: "assistant", stopReason: "toolUse" } });
        tracker.observe({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Provider unavailable" } });
        tracker.observe({ type: "agent_settled", aborted: false });
        expect(tracker.outcome()).toBe("error");
        expect(tracker.description()).toBe("Provider unavailable");
    });
});
