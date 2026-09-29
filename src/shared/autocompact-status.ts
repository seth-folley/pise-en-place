import type { ThemeColor } from "@earendil-works/pi-coding-agent";

// Session-scoped exchange between the compaction policy and optional custom footer.
// Use Pi's event bus rather than module globals: extensions can have separate module roots.
export const AUTOCOMPACT_STATUS_EVENT = "pise:autocompact:status";
export const AUTOCOMPACT_STATUS_REQUEST = "pise:autocompact:status-request";
export const AUTOCOMPACT_SYMBOL = "≡";

export interface AutoCompactStatus {
    sessionId: string;
    enabled: boolean;
    ceilingTokens: number;
}

export function isAutoCompactStatus(value: unknown): value is AutoCompactStatus {
    if (!value || typeof value !== "object") return false;
    const status = value as Partial<AutoCompactStatus>;
    return typeof status.sessionId === "string" && typeof status.enabled === "boolean" &&
        typeof status.ceilingTokens === "number" && Number.isSafeInteger(status.ceilingTokens) && status.ceilingTokens > 0;
}

// Native compaction remains independent and may trigger earlier with custom settings.
export function effectiveCeiling(ceilingTokens: number, contextWindow?: number): number {
    if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) return ceilingTokens;
    const reserve = Math.min(16_384, Math.ceil(contextWindow * 0.2));
    return Math.min(ceilingTokens, Math.max(1, contextWindow - reserve));
}

export function autoCompactIndicatorColor(
    status: Pick<AutoCompactStatus, "enabled" | "ceilingTokens">,
    tokens: number | null | undefined,
    contextWindow?: number,
): ThemeColor {
    if (!status.enabled) return "dim";
    if (tokens == null || !Number.isFinite(tokens) || tokens < 0) return "accent";
    const limit = effectiveCeiling(status.ceilingTokens, contextWindow);
    return tokens >= limit * 0.9 ? "error" : tokens >= limit * 0.8 ? "warning" : "success";
}
