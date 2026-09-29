import { describe, expect, it } from "vitest";
import { autoCompactIndicatorColor, isAutoCompactStatus } from "../src/shared/autocompact-status.ts";

const enabled = { enabled: true, ceilingTokens: 250_000 };

describe("autocompact indicator", () => {
    it("colors the effective compaction ceiling, not the model window", () => {
        expect(autoCompactIndicatorColor(enabled, 0, 1_000_000)).toBe("success");
        expect(autoCompactIndicatorColor(enabled, 199_999, 1_000_000)).toBe("success");
        expect(autoCompactIndicatorColor(enabled, 200_000, 1_000_000)).toBe("warning");
        expect(autoCompactIndicatorColor(enabled, 224_999, 1_000_000)).toBe("warning");
        expect(autoCompactIndicatorColor(enabled, 225_000, 1_000_000)).toBe("error");
        expect(autoCompactIndicatorColor(enabled, 300_000, 1_000_000)).toBe("error");
        expect(autoCompactIndicatorColor(enabled, 100_456, 128_000)).toBe("error");
    });

    it("distinguishes disabled from enabled with unknown usage", () => {
        expect(autoCompactIndicatorColor({ ...enabled, enabled: false }, 300_000)).toBe("dim");
        for (const tokens of [null, undefined, NaN, Infinity, -1]) {
            expect(autoCompactIndicatorColor(enabled, tokens)).toBe("accent");
        }
    });

    it("validates status events", () => {
        expect(isAutoCompactStatus({ sessionId: "test", ...enabled })).toBe(true);
        for (const value of [null, {}, enabled, { sessionId: "test", ...enabled, ceilingTokens: 0 },
            { sessionId: "test", ...enabled, enabled: "true" }]) {
            expect(isAutoCompactStatus(value)).toBe(false);
        }
    });
});
