export const FAST_STATUS_EVENT = "pise:fast:status";
export const FAST_STATUS_REQUEST = "pise:fast:status-request";
export const FAST_INDICATOR = "⚡ fast";

export interface FastStatus {
    sessionId: string;
    provider: string;
    model: string;
    enabled: boolean;
}

export function isFastStatus(value: unknown): value is FastStatus {
    if (!value || typeof value !== "object") return false;
    const status = value as Partial<FastStatus>;
    return typeof status.sessionId === "string" && typeof status.provider === "string" &&
        typeof status.model === "string" && typeof status.enabled === "boolean";
}

export interface FastModel {
    provider: string;
    id: string;
    api: string;
    baseUrl: string;
}

// Provider identity alone must not enable priority on a models.json proxy.
export function supportsFast(model: FastModel | undefined): boolean {
    if (!model || !["openai", "openai-codex"].includes(model.provider)) return false;
    if (model.api !== (model.provider === "openai" ? "openai-responses" : "openai-codex-responses")) return false;
    try {
        const url = new URL(model.baseUrl);
        if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash) return false;
        const path = url.pathname.replace(/\/+$/, "");
        return model.api === "openai-responses"
            ? url.hostname === "api.openai.com" && path === "/v1"
            : url.hostname === "chatgpt.com" && ["/backend-api", "/backend-api/codex", "/backend-api/codex/responses"].includes(path);
    } catch {
        return false;
    }
}

export function fastIndicatorFor(status: FastStatus | undefined, model: FastModel | undefined): string {
    return status?.enabled && supportsFast(model) && status.provider === model?.provider && status.model === model.id
        ? FAST_INDICATOR : "";
}
