import { describe, expect, it, vi } from "vitest";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { SkillEvalMonitor } from "../extensions/evals/skill-eval/monitor.ts";
import type { NormalizedSkillEvalConfig } from "../extensions/evals/skill-eval/config.ts";

function fixture() {
    const config: NormalizedSkillEvalConfig = {
        version: 1, name: "completion", workspace: ".", agent: { harness: "pi", model: "test/model" },
        limits: { timeoutSeconds: 60, onTimeout: "stop", maxRetries: 0 }, dialogs: "auto-reject",
        variants: { first: { prompt: "Task" } },
    };
    const monitor = new SkillEvalMonitor(config,
        { requestRender: vi.fn(), terminal: { rows: 20 } } as unknown as TUI,
        { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme,
        { getKeys: () => [], matches: () => false } as unknown as KeybindingsManager, vi.fn(), vi.fn());
    const emit = (kind: string, data?: unknown) => monitor.onEvent({ timestamp: new Date().toISOString(), runId: "run", variantId: "first", kind, data });
    emit("variant_preparing"); emit("variant_started");
    return { monitor, emit, text: () => monitor.render(160).join("\n") };
}

describe("eval monitor completion labels", () => {
    it.each(["agent_error", "truncated", "incomplete", "cancelled"])("keeps %s distinct after teardown settles", status => {
        const h = fixture();
        try {
            h.emit(`variant_${status}`);
            h.emit("variant_phase_changed", { phase: "settled" });
            expect(h.text()).toContain(`first  ${status.replaceAll("_", " ")}`);
            expect(h.text()).not.toContain("first  completed");
        } finally { h.monitor.dispose(); }
    });

    it("does not infer completion from the teardown phase alone", () => {
        const h = fixture();
        try {
            h.emit("variant_phase_changed", { phase: "settled" });
            expect(h.text()).toContain("first  incomplete");
        } finally { h.monitor.dispose(); }
    });

    it("shows confirmed completion when the runner explicitly reports it", () => {
        const h = fixture();
        try {
            h.emit("variant_completed");
            h.emit("variant_phase_changed", { phase: "settled" });
            expect(h.text()).toContain("first  completed");
        } finally { h.monitor.dispose(); }
    });
});
