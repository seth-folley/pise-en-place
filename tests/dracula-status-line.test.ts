import { stripVTControlCharacters } from "node:util";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import statusLine from "../extensions/ui/dracula-status-line.ts";
import { AUTOCOMPACT_STATUS_EVENT, AUTOCOMPACT_STATUS_REQUEST } from "../src/shared/autocompact-status.ts";

async function harness(providerFirst = false) {
    const events = createEventBus();
    const handlers = new Map<string, (...args: any[]) => any>();
    const commands = new Map<string, any>();
    const requestRender = vi.fn();
    const unsubscribeBranch = vi.fn();
    const status = { sessionId: "one", enabled: true, ceilingTokens: 250_000 };
    if (providerFirst) events.on(AUTOCOMPACT_STATUS_REQUEST, id => {
        if (id === "one") events.emit(AUTOCOMPACT_STATUS_EVENT, status);
    });
    const api = {
        events,
        on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
        registerCommand: (name: string, command: any) => commands.set(name, command),
        getThinkingLevel: () => "off",
    };
    const colors: Record<string, number> = { success: 32, warning: 33, error: 31, dim: 90, accent: 36 };
    const theme = { fg: (color: string, text: string) => `\x1b[${colors[color] ?? 37}m${text}\x1b[0m`, bold: (text: string) => text };
    let footer: { render(width: number): string[]; dispose(): void } | undefined;
    let tokens: number | null = 100_000;
    const entries: unknown[] = [];
    let branch: unknown[] = [];
    const ctx = {
        sessionManager: { getSessionId: () => "one", getBranch: () => branch, getEntries: () => entries },
        model: { id: "test", contextWindow: 1_000_000 },
        getContextUsage: () => ({ tokens, percent: tokens === null ? null : tokens / 10_000, contextWindow: 1_000_000 }),
        ui: {
            setFooter: (factory: any) => {
                footer?.dispose();
                footer = factory?.({ requestRender }, theme, {
                    onBranchChange: () => unsubscribeBranch,
                    getGitBranch: () => "main",
                    getExtensionStatuses: () => new Map(),
                });
            },
            setTitle: vi.fn(), notify: vi.fn(),
        },
    } as unknown as ExtensionContext;
    statusLine(api as unknown as ExtensionAPI);
    await handlers.get("session_start")!({}, ctx);
    return {
        events, status, requestRender, unsubscribeBranch, entries,
        branch: (values: unknown[]) => { branch = values; },
        assistantComplete: () => handlers.get("message_end")!({ message: { role: "assistant", stopReason: "stop", usage: { cacheRead: 20 } } }, ctx),
        render: (width = 120) => footer!.render(width),
        usage: (value: number | null) => { tokens = value; },
        cycle: () => commands.get("statusline").handler("", ctx),
    };
}

describe("Dracula footer autocompact symbol", () => {
    it("renders next to the bar in both footer styles and updates on live usage", async () => {
        const h = await harness(true);
        expect(h.render()[1]).toContain("\x1b[32m≡\x1b[0m");
        expect(h.render()[1]).toMatch(/░.*≡/);
        h.usage(200_000);
        expect(h.render()[1]).toContain("\x1b[33m≡\x1b[0m");
        h.usage(225_000);
        expect(h.render()[1]).toContain("\x1b[31m≡\x1b[0m");
        await h.cycle(); // minimal, requests current policy again
        expect(h.render()[1]).toContain("\x1b[31m≡\x1b[0m");
        h.usage(null);
        expect(h.render()[1]).toContain("\x1b[36m≡\x1b[0m");
        for (const width of [1, 20, 50, 80, 120]) {
            expect(h.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
        }
    });

    it("handles either load order, filters other sessions, and repaints configuration changes", async () => {
        const h = await harness();
        expect(h.render()[1]).not.toContain("≡"); // policy extension absent/not initialized
        h.events.emit(AUTOCOMPACT_STATUS_EVENT, { ...h.status, sessionId: "other" });
        h.events.emit(AUTOCOMPACT_STATUS_EVENT, {});
        expect(h.requestRender).not.toHaveBeenCalled();
        h.events.emit(AUTOCOMPACT_STATUS_EVENT, h.status);
        expect(h.requestRender).toHaveBeenCalledOnce();
        expect(h.render()[1]).toContain("\x1b[32m≡\x1b[0m");
        h.events.emit(AUTOCOMPACT_STATUS_EVENT, { ...h.status, enabled: false });
        expect(h.render()[1]).toContain("\x1b[90m≡\x1b[0m");
    });

    it("shows full-session usage including caches, tools and summaries independent of the active branch", async () => {
        const h = await harness();
        const usage = { input: 10, output: 5, cacheRead: 20, cacheWrite: 15, cost: { total: 0.1 } };
        h.entries.push(...["message", "message", "compaction", "branch_summary", "usage"].map((type, index) => ({
            id: `entry-${index}`, type, timestamp: "2026-10-13T12:00:00Z", usage,
            message: { role: index === 0 ? "assistant" : "toolResult", usage },
        })));
        const line = () => stripVTControlCharacters(h.render()[1]);
        expect(line()).toContain("↑ 50"); expect(line()).toContain("↓ 25");
        expect(line()).toContain("Σ 250"); expect(line()).toContain("$0.50");
        h.branch([h.entries[4]]);
        expect(line()).toContain("Σ 250");
        h.usage(350_000); await h.assistantComplete(); expect(line()).toContain("35%");
        await h.cycle(); expect(line()).toContain("Σ 250"); expect(line()).toContain("$0.50");
    });

    it("cleans up event subscriptions when the footer is replaced or turned off", async () => {
        const h = await harness(true);
        await h.cycle(); // dracula -> minimal
        const before = h.requestRender.mock.calls.length;
        h.events.emit(AUTOCOMPACT_STATUS_EVENT, h.status);
        expect(h.requestRender).toHaveBeenCalledTimes(before + 1);
        await h.cycle(); // minimal -> off
        const after = h.requestRender.mock.calls.length;
        h.events.emit(AUTOCOMPACT_STATUS_EVENT, h.status);
        expect(h.requestRender).toHaveBeenCalledTimes(after);
        expect(h.unsubscribeBranch).toHaveBeenCalledTimes(2);
    });
});
