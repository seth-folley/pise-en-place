export type ContextUsageReading = {
    tokens: number | null;
    percent: number | null;
};

export type AssistantUsageMetadata = {
    stopReason?: string;
    usage?: { cacheRead?: number };
};

export type ContextUsageDisplayState = {
    reliable?: ContextUsageReading;
    useRetainedReading: boolean;
    awaitingReliableReading: boolean;
};

const suspiciousDropRatio = 0.2;

export function createContextUsageDisplayState(): ContextUsageDisplayState {
    return { useRetainedReading: false, awaitingReliableReading: false };
}

export function clearContextUsageDisplayState(state: ContextUsageDisplayState): void {
    state.reliable = undefined;
    state.useRetainedReading = false;
    state.awaitingReliableReading = true;
}

export function recordAssistantContextUsage(
    state: ContextUsageDisplayState,
    message: AssistantUsageMetadata,
    reading: ContextUsageReading,
): void {
    const hasReading = reading.tokens !== null && reading.percent !== null;
    const isUncachedToolUse = message.stopReason === "toolUse" && (message.usage?.cacheRead ?? 0) === 0;

    if (!hasReading) return;

    if (state.awaitingReliableReading && isUncachedToolUse) {
        state.useRetainedReading = false;
        return;
    }

    const previousTokens = state.reliable?.tokens;
    const currentTokens = reading.tokens;
    const isSuspiciousDrop = isUncachedToolUse &&
        previousTokens !== null && previousTokens !== undefined &&
        currentTokens !== null &&
        currentTokens < previousTokens * suspiciousDropRatio;

    if (isSuspiciousDrop) {
        state.useRetainedReading = true;
        return;
    }

    state.reliable = reading;
    state.useRetainedReading = false;
    state.awaitingReliableReading = false;
}

export function getContextUsageDisplay(
    state: ContextUsageDisplayState,
    liveReading: ContextUsageReading,
): ContextUsageReading & { estimated: boolean } {
    if (state.awaitingReliableReading) return { tokens: null, percent: null, estimated: false };
    if (state.useRetainedReading && state.reliable) return { ...state.reliable, estimated: true };
    return { ...liveReading, estimated: false };
}
