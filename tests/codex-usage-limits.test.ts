import { describe, expect, it, vi } from "vitest";
import usageExtension from "../extensions/usage/index.ts";
import {
	codexAccountId,
	codexUsageWindowText,
	fetchCodexUsageLimits,
	formatReset,
	parseCodexUsageLimits,
} from "../src/shared/codex-usage-limits.ts";

function token(payload: unknown): string {
	return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

describe("Codex usage limits", () => {
	it("parses rolling windows and computes a reset time", () => {
		const now = 1_700_000_000_000;
		const limits = parseCodexUsageLimits({
			plan_type: "pro",
			rate_limit: {
				limit_reached: false,
				primary_window: { used_percent: 17.6, limit_window_seconds: 18_000, reset_after_seconds: 3_600 },
				secondary_window: { used_percent: 42, limit_window_seconds: 604_800, reset_at: 1_700_200_000 },
			},
			additional_rate_limits: [{
				limit_name: "GPT-5.3-Codex-Spark",
				rate_limit: { primary_window: { used_percent: 3, limit_window_seconds: 18_000 } },
			}],
		}, now);

		expect(limits).toMatchObject({
			planType: "pro",
			limitReached: false,
			primary: { usedPercent: 17.6, windowSeconds: 18_000, resetsAt: now + 3_600_000 },
			secondary: { usedPercent: 42, windowSeconds: 604_800, resetsAt: 1_700_200_000_000 },
		});
		expect(limits.additional).toMatchObject([{ name: "GPT-5.3-Codex-Spark", primary: { usedPercent: 3 } }]);
		expect(codexUsageWindowText(limits.primary!, "Primary", now)).toBe("5-hour: 18% used · resets in 1h");
		expect(codexUsageWindowText(limits.secondary!, "Secondary", now)).toBe("Weekly: 42% used · resets in 2d 7h");
	});

	it("extracts the ChatGPT account ID from Pi's OAuth token", () => {
		const accessToken = token({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } });
		expect(codexAccountId(accessToken)).toBe("acct-123");
		expect(codexAccountId("not-a-jwt")).toBeNull();
	});

	it("fetches usage with the expected account-scoped authorization", async () => {
		const accessToken = token({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } });
		const fetcher = vi.fn(async () => new Response(JSON.stringify({
			plan_type: "pro",
			rate_limit: { primary_window: { used_percent: 25 } },
		}), { status: 200, headers: { "content-type": "application/json" } }));

		const limits = await fetchCodexUsageLimits(accessToken, { fetch: fetcher, now: () => 123 });
		expect(limits.primary?.usedPercent).toBe(25);
		expect(fetcher).toHaveBeenCalledWith(
			"https://chatgpt.com/backend-api/wham/usage",
			expect.objectContaining({
				method: "GET",
				redirect: "error",
				headers: expect.objectContaining({
					authorization: `Bearer ${accessToken}`,
					"chatgpt-account-id": "acct-123",
				}),
			}),
		);
	});

	it("rejects unrecognized responses and formats expired resets", () => {
		expect(() => parseCodexUsageLimits({ rate_limit: {} })).toThrow("no recognized usage windows");
		expect(formatReset(1_000, 2_000)).toBe("resets in <1m");
	});

	it("does not send a request when the caller is already aborted", async () => {
		const accessToken = token({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } });
		const fetcher = vi.fn();
		const controller = new AbortController();
		controller.abort();
		await expect(fetchCodexUsageLimits(accessToken, { fetch: fetcher, signal: controller.signal })).rejects.toThrow("cancelled");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("fetches limits on demand through /usage openai without updating a widget", async () => {
		let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
		usageExtension({
			on: () => {},
			registerCommand: (_name: string, command: any) => { handler = command.handler; },
			appendEntry: () => {},
		} as any);
		const notices: string[] = [];
		const accessToken = token({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } });
		const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
			plan_type: "prolite",
			rate_limit: { primary_window: { used_percent: 6, limit_window_seconds: 604_800, reset_after_seconds: 60 } },
		}), { status: 200 }));
		const ctx = {
			modelRegistry: { getApiKeyForProvider: async () => accessToken },
			ui: {
				notify: (text: string) => notices.push(text),
				setWidget: vi.fn(),
			},
		};

		try {
			await handler!("openai", ctx);
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(notices.at(-1)).toContain("OpenAI Codex subscription limits · Pro");
			expect(notices.at(-1)).toContain("Weekly: 6% used");
			expect(ctx.ui.setWidget).not.toHaveBeenCalled();
		} finally {
			fetcher.mockRestore();
		}
	});
});
