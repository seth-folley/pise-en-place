import { describe, expect, it } from "vitest";
import { CompactionCycle, effectiveCeiling } from "../extensions/productivity/autocompact/policy.ts";

describe("autocompact policy", () => {
    it("uses an absolute ceiling and leaves headroom on smaller models", () => {
        expect(effectiveCeiling(250_000, 1_000_000)).toBe(250_000);
        expect(effectiveCeiling(250_000, 128_000)).toBe(111_616);
        expect(effectiveCeiling(250_000, 8192)).toBe(6553);
        expect(effectiveCeiling(250_000)).toBe(250_000);
    });

    it("warns at 80 and 90 percent once each, and requires compaction at 100", () => {
        const cycle = new CompactionCycle();
        expect(cycle.observe(199_999, 250_000)).toBeUndefined();
        expect(cycle.observe(200_000, 250_000)).toBe(80);
        expect(cycle.observe(210_000, 250_000)).toBeUndefined();
        expect(cycle.observe(225_000, 250_000)).toBe(90);
        expect(cycle.observe(249_999, 250_000)).toBeUndefined();
        expect(cycle.observe(250_000, 250_000)).toBe("compact");
    });

    it("emits only the strongest warning when usage jumps", () => {
        const cycle = new CompactionCycle();
        expect(cycle.observe(230_000, 250_000)).toBe(90);
        expect(cycle.observe(200_000, 250_000)).toBeUndefined();
        expect(cycle.observe(300_000, 250_000)).toBe("compact");
    });

    it("does not loop on a failed or insufficient compaction", () => {
        const cycle = new CompactionCycle();
        cycle.markAttempt();
        expect(cycle.observe(260_000, 250_000)).toBe("blocked");
        cycle.compacted();
        expect(cycle.observe(null, 250_000)).toBeUndefined();
        expect(cycle.observe(260_000, 250_000)).toBe("blocked");
        expect(cycle.observe(30_000, 250_000)).toBeUndefined();
        expect(cycle.observe(200_000, 250_000)).toBe(80);
        expect(cycle.observe(250_000, 250_000)).toBe("compact");
    });

    it("ignores unreliable usage and resets on model/session changes", () => {
        const cycle = new CompactionCycle();
        for (const tokens of [undefined, null, NaN, Infinity, -1]) {
            expect(cycle.observe(tokens, 250_000)).toBeUndefined();
        }
        cycle.markAttempt();
        cycle.reset();
        expect(cycle.observe(250_000, 250_000)).toBe("compact");
    });
});
