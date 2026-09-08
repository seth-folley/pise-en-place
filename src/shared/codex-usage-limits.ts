export const codexUsageEndpoint = "https://chatgpt.com/backend-api/wham/usage";

export type CodexUsageWindow = {
	usedPercent: number;
	windowSeconds: number | null;
	resetsAt: number | null;
};

export type CodexAdditionalLimit = {
	name: string;
	limitReached: boolean;
	primary: CodexUsageWindow | null;
	secondary: CodexUsageWindow | null;
};

export type CodexUsageLimits = {
	planType: string | null;
	limitReached: boolean;
	primary: CodexUsageWindow | null;
	secondary: CodexUsageWindow | null;
	additional: CodexAdditionalLimit[];
	fetchedAt: number;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function object(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseWindow(value: unknown, now: number): CodexUsageWindow | null {
	const source = object(value);
	if (!source) return null;
	const usedPercent = finiteNumber(source.used_percent);
	if (usedPercent === null) return null;
	const windowSeconds = finiteNumber(source.limit_window_seconds);
	const resetAtSeconds = finiteNumber(source.reset_at);
	const resetAfterSeconds = finiteNumber(source.reset_after_seconds);
	const resetsAt = resetAtSeconds !== null
		? resetAtSeconds * 1_000
		: resetAfterSeconds !== null
			? now + resetAfterSeconds * 1_000
			: null;
	return {
		usedPercent: Math.max(0, Math.min(100, usedPercent)),
		windowSeconds: windowSeconds === null ? null : Math.max(0, windowSeconds),
		resetsAt,
	};
}

export function parseCodexUsageLimits(value: unknown, now = Date.now()): CodexUsageLimits {
	const source = object(value);
	if (!source) throw new Error("OpenAI returned an invalid usage response");
	const rateLimit = object(source.rate_limit);
	if (!rateLimit) throw new Error("OpenAI usage limits were missing from the response");
	const primary = parseWindow(rateLimit.primary_window, now);
	const secondary = parseWindow(rateLimit.secondary_window, now);
	const additional = Array.isArray(source.additional_rate_limits)
		? source.additional_rate_limits.flatMap((value): CodexAdditionalLimit[] => {
			const item = object(value);
			const nested = object(item?.rate_limit);
			if (!item || !nested) return [];
			const nestedPrimary = parseWindow(nested.primary_window, now);
			const nestedSecondary = parseWindow(nested.secondary_window, now);
			if (!nestedPrimary && !nestedSecondary) return [];
			return [{
				name: typeof item.limit_name === "string" && item.limit_name.length > 0 ? item.limit_name : "Additional limit",
				limitReached: nested.limit_reached === true,
				primary: nestedPrimary,
				secondary: nestedSecondary,
			}];
		})
		: [];
	if (!primary && !secondary && additional.length === 0) throw new Error("OpenAI returned no recognized usage windows");
	return {
		planType: typeof source.plan_type === "string" ? source.plan_type : null,
		limitReached: rateLimit.limit_reached === true,
		primary,
		secondary,
		additional,
		fetchedAt: now,
	};
}

export function codexAccountId(accessToken: string): string | null {
	const segments = accessToken.split(".");
	if (segments.length < 2) return null;
	try {
		const payload = object(JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf8")));
		const auth = object(payload?.["https://api.openai.com/auth"]);
		const value = auth?.chatgpt_account_id ?? payload?.chatgpt_account_id;
		return typeof value === "string" && value.length > 0 ? value : null;
	} catch {
		return null;
	}
}

export async function fetchCodexUsageLimits(
	accessToken: string,
	options: { fetch?: FetchLike; signal?: AbortSignal; now?: () => number } = {},
): Promise<CodexUsageLimits> {
	const accountId = codexAccountId(accessToken);
	if (!accountId) throw new Error("The OpenAI login does not include a ChatGPT account ID");
	const fetcher = options.fetch ?? fetch;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 10_000);
	const abort = () => controller.abort();
	if (options.signal?.aborted) controller.abort();
	else options.signal?.addEventListener("abort", abort, { once: true });
	try {
		if (controller.signal.aborted) throw new Error("OpenAI usage request was cancelled");
		const response = await fetcher(codexUsageEndpoint, {
			method: "GET",
			headers: {
				accept: "application/json",
				authorization: `Bearer ${accessToken}`,
				"chatgpt-account-id": accountId,
				originator: "codex_cli_rs",
			},
			redirect: "error",
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`OpenAI usage request failed (${response.status})`);
		return parseCodexUsageLimits(await response.json(), options.now?.() ?? Date.now());
	} catch (error: any) {
		if (controller.signal.aborted) throw new Error(options.signal?.aborted ? "OpenAI usage request was cancelled" : "OpenAI usage request timed out");
		throw error;
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abort);
	}
}

export function codexWindowLabel(window: CodexUsageWindow, fallback: string): string {
	const hours = window.windowSeconds === null ? null : window.windowSeconds / 3_600;
	if (hours !== null && hours >= 24 * 6) return "Weekly";
	if (hours !== null && hours >= 1) return `${Math.round(hours)}-hour`;
	return fallback;
}

export function formatReset(resetsAt: number | null, now = Date.now()): string {
	if (resetsAt === null) return "reset unknown";
	const remaining = Math.max(0, resetsAt - now);
	if (remaining < 60_000) return "resets in <1m";
	const minutes = Math.ceil(remaining / 60_000);
	if (minutes < 60) return `resets in ${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	if (hours < 48) return `resets in ${hours}h${restMinutes ? ` ${restMinutes}m` : ""}`;
	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	return `resets in ${days}d${restHours ? ` ${restHours}h` : ""}`;
}

export function codexUsageWindowText(window: CodexUsageWindow, fallback: string, now = Date.now()): string {
	return `${codexWindowLabel(window, fallback)}: ${Math.round(window.usedPercent)}% used · ${formatReset(window.resetsAt, now)}`;
}

function planLabel(planType: string | null): string | null {
	if (!planType) return null;
	if (planType === "prolite" || planType === "pro") return "Pro";
	return planType.charAt(0).toUpperCase() + planType.slice(1);
}

export function formatCodexUsageLimits(limits: CodexUsageLimits, now = Date.now()): string {
	const plan = planLabel(limits.planType);
	const lines = [`OpenAI Codex subscription limits${plan ? ` · ${plan}` : ""}`];
	if (limits.primary) lines.push(codexUsageWindowText(limits.primary, "Primary", now));
	if (limits.secondary) lines.push(codexUsageWindowText(limits.secondary, "Secondary", now));
	if (limits.limitReached) lines.push("Limit reached");
	for (const additional of limits.additional) {
		lines.push(additional.name);
		if (additional.primary) lines.push(`  ${codexUsageWindowText(additional.primary, "Primary", now)}`);
		if (additional.secondary) lines.push(`  ${codexUsageWindowText(additional.secondary, "Secondary", now)}`);
		if (additional.limitReached) lines.push("  Limit reached");
	}
	lines.push(`Updated ${new Date(limits.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
	return lines.join("\n");
}
