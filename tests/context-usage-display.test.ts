import { describe, expect, it } from "vitest";
import {
    clearContextUsageDisplayState,
    createContextUsageDisplayState,
    getContextUsageDisplay,
    recordAssistantContextUsage,
} from "../src/shared/context-usage-display.ts";

const reliableReading = { tokens: 136_254, percent: 50.1 };
const collapsedToolReading = { tokens: 772, percent: 0.3 };

describe("context usage display", () => {
    it("retains the previous reliable reading after an uncached tool-use collapse", () => {
        const state = createContextUsageDisplayState();
        recordAssistantContextUsage(state, { stopReason: "stop", usage: { cacheRead: 135_680 } }, reliableReading);
        recordAssistantContextUsage(state, { stopReason: "toolUse", usage: { cacheRead: 0 } }, collapsedToolReading);

        expect(getContextUsageDisplay(state, collapsedToolReading)).toEqual({ ...reliableReading, estimated: true });
    });

    it("accepts the next reliable assistant usage reading", () => {
        const state = createContextUsageDisplayState();
        recordAssistantContextUsage(state, { stopReason: "stop", usage: { cacheRead: 135_680 } }, reliableReading);
        recordAssistantContextUsage(state, { stopReason: "toolUse", usage: { cacheRead: 0 } }, collapsedToolReading);
        const recoveredReading = { tokens: 140_037, percent: 51.5 };
        recordAssistantContextUsage(state, { stopReason: "stop", usage: { cacheRead: 138_752 } }, recoveredReading);

        expect(getContextUsageDisplay(state, recoveredReading)).toEqual({ ...recoveredReading, estimated: false });
    });

    it("shows unavailable context after compaction until a reliable reading arrives", () => {
        const state = createContextUsageDisplayState();
        recordAssistantContextUsage(state, { stopReason: "stop", usage: { cacheRead: 135_680 } }, reliableReading);
        clearContextUsageDisplayState(state);
        recordAssistantContextUsage(state, { stopReason: "toolUse", usage: { cacheRead: 0 } }, collapsedToolReading);

        expect(getContextUsageDisplay(state, collapsedToolReading)).toEqual({ tokens: null, percent: null, estimated: false });
    });

    it("passes ordinary usage through unchanged", () => {
        const state = createContextUsageDisplayState();
        const reading = { tokens: 12_000, percent: 4.4 };
        recordAssistantContextUsage(state, { stopReason: "stop", usage: { cacheRead: 0 } }, reading);

        expect(getContextUsageDisplay(state, reading)).toEqual({ ...reading, estimated: false });
    });
});
