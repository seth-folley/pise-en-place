import { describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { createOverviewComponent, MessageDetailComponent, showTeamDashboard, type DashboardIntent, type DashboardMessage } from "../../extensions/coordination/dashboard.ts";
import type { CoordinationRuntime } from "../../extensions/coordination/runtime.ts";
import type { Binding, Message, MessageSummary, Page, Status } from "../../src/coordination/protocol.ts";

const DOWN = "\x1b[B", ENTER = "\r", ESC = "\x1b", CTRL_C = "\x03", PAGE_DOWN = "\x1b[6~";
const theme = {
    fg: (_color: string, text: string) => `\x1b[32m${text}\x1b[0m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as Theme;
const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;

function status(participants = 0): Status {
    return {
        room: { id: "room-1", name: "catalog", paused: 0 }, you: "self", questions: 0, discussions: 1, attention: 0,
        observedAt: 1, automation: { roomUsed: 0, roomLimit: 100, threadLimit: null, blocked: 0 },
        participants: Array.from({ length: participants }, (_, index) => ({
            id: `participant-${index}`, room_id: "room-1", name: `Peer ${index}`, role: "worker", joined: 1, paused: 0,
            runtime: "idle" as const, last_seen: 1, summary: "Working", blocker: "", pause_reason: "", presence: "connected" as const,
            pending: 0, unread: 0, needsReply: 0, workTruncated: false,
        })),
    };
}
function message(id = "message-1", body = "Body"): Message {
    return {
        id, room_id: "room-1", thread_id: "thread-1", sequence: 1, sender_id: "sender", author_name: "Backend", author_role: "worker",
        author_kind: "peer", actionable: false, type: "question", body, reply_to: null, references: [], created_at: 1,
        subject: "Need input", thread_state: "open", deliveries: [],
    };
}
function summary(id = "message-1"): MessageSummary {
    const { body, references: _references, ...rest } = message(id);
    return { ...rest, preview: body };
}
function dashboardMessage(id = "message-1"): DashboardMessage {
    return { id, threadId: "thread-1", type: "question", subject: "Need input", authorName: "Backend", sequence: 1, createdAt: 1, threadState: "open" };
}
function page(items: MessageSummary[] = [], nextCursor: number | null = null): Page { return { items, nextCursor }; }

function overview(keys: string[], state = { status: status(), messages: [] as DashboardMessage[], nextCursor: null, history: false }) {
    let result: DashboardIntent | undefined;
    const component = createOverviewComponent({ requestRender: vi.fn() }, plainTheme, (value) => { result = value; }, state);
    for (const key of keys) component.handleInput?.(key);
    return { result, component };
}

function plannedContext(plans: string[][], events: string[] = []) {
    const components: Component[] = [];
    const custom = vi.fn(async (factory: Function) => new Promise<unknown>((resolve) => {
        let active = true;
        const done = (value: unknown) => { active = false; events.push("disposed"); resolve(value); };
        const component = factory({ requestRender: vi.fn() }, theme, {}, done);
        components.push(component);
        events.push("opened");
        for (const key of plans.shift() ?? [ESC]) component.handleInput?.(key);
        if (active) throw new Error("Planned custom UI did not close");
    }));
    const context = { mode: "tui", hasUI: true, ui: { custom, notify: vi.fn() } } as unknown as ExtensionCommandContext;
    return { context, custom, components };
}
function fakeRuntime(responses: unknown[]) {
    const binding: Binding = { roomId: "room-1", roomName: "catalog", participantId: "self", name: "App", role: "worker", sessionId: "session" };
    const client = { call: vi.fn(async (_operation: string, _params: Record<string, unknown>) => {
        const value = responses.shift();
        if (value instanceof Error) throw value;
        return value;
    }) };
    let interactive = false;
    const runtime = {
        binding,
        requireClient: () => ({ client, binding }),
        isCurrentBinding: (candidate: Binding) => candidate === runtime.binding,
        rememberStatus: vi.fn(), rememberPage: vi.fn(), rememberMessage: vi.fn(),
        subscribe: vi.fn(() => vi.fn()),
        withInteractiveFlow: async (fn: () => Promise<unknown>) => { interactive = true; try { return await fn(); } finally { interactive = false; } },
    } as unknown as CoordinationRuntime & { binding?: Binding };
    return { runtime, client, binding, isInteractive: () => interactive };
}

describe("team dashboard components", () => {
    it("selects the first message by ID and handles refresh, escape, and Ctrl-C", () => {
        expect(overview([ENTER], { status: status(), messages: [dashboardMessage()], nextCursor: null, history: false }).result).toEqual({ kind: "message", messageId: "message-1" });
        expect(overview(["r"]).result).toEqual({ kind: "refresh" });
        expect(overview([ESC]).result).toEqual({ kind: "close" });
        expect(overview([CTRL_C]).result).toEqual({ kind: "close" });
    });
    it("renders empty and partial-error states safely at narrow widths and across themes", () => {
        for (const currentTheme of [plainTheme, theme]) {
            const component = createOverviewComponent({ requestRender: vi.fn() }, currentTheme, vi.fn(), {
                messages: [], nextCursor: null, history: false, statusError: "bad\u001b[31m status", inboxError: "bad\u0085 inbox",
            });
            for (const width of [0, 1, 3, 4, 12, 40, 80]) {
                for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
            }
            const rendered = component.render(80).join("\n");
            expect(rendered).toContain("Inbox is empty");
            expect(rendered).not.toContain("\u001b[31m status");
            expect(rendered).not.toContain("\u0085");
        }
    });
    it("scrolls long sanitized message bodies with arrows and page keys", () => {
        const done = vi.fn(), tui = { requestRender: vi.fn() };
        const body = Array.from({ length: 40 }, (_, index) => `line ${index}\u0085`).join("\n");
        const component = new MessageDetailComponent(tui, plainTheme, message("message-1", body), done);
        const before = component.render(40).join("\n");
        component.handleInput?.(PAGE_DOWN);
        const after = component.render(40).join("\n");
        expect(after).not.toBe(before);
        expect(after).not.toContain("\u0085");
        component.handleInput?.(ENTER);
        expect(done).toHaveBeenLastCalledWith({ kind: "message", messageId: "message-1" });
        for (const width of [0, 1, 3, 4, 12, 40, 80]) for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    });
});

describe("team dashboard controller", () => {
    it("opens with exactly status and inbox reads and tolerates a partial failure", async () => {
        const { runtime, client } = fakeRuntime([status(), new Error("inbox unavailable")]);
        const { context, components } = plannedContext([[ESC]]);
        await showTeamDashboard(runtime, context, vi.fn());
        expect(client.call).toHaveBeenCalledTimes(2);
        expect(client.call.mock.calls.map((call) => call[0])).toEqual(["status", "read"]);
        expect(components[0]?.render(80).join("\n")).toContain("Inbox: inbox unavailable");
    });
    it("refreshes explicitly, toggles history, and loads more without polling", async () => {
        const refreshRuntime = fakeRuntime([status(), page(), status(), page()]);
        await showTeamDashboard(refreshRuntime.runtime, plannedContext([["r"], [ESC]]).context, vi.fn());
        expect(refreshRuntime.client.call).toHaveBeenCalledTimes(4);

        const historyRuntime = fakeRuntime([status(), page(), status(), page()]);
        await showTeamDashboard(historyRuntime.runtime, plannedContext([[DOWN, DOWN, ENTER], [ESC]]).context, vi.fn());
        expect(historyRuntime.client.call.mock.calls[3]?.[1]).toMatchObject({ history: true, cursor: 0 });

        const moreRuntime = fakeRuntime([status(), page([summary("one")], 7), page([summary("two")], null)]);
        await showTeamDashboard(moreRuntime.runtime, plannedContext([[DOWN, ENTER], [ESC]]).context, vi.fn());
        expect(moreRuntime.client.call).toHaveBeenCalledTimes(3);
        expect(moreRuntime.client.call.mock.calls[2]?.[1]).toMatchObject({ cursor: 7 });
        expect(moreRuntime.runtime.rememberPage).toHaveBeenCalledTimes(2);
    });
    it("disposes overlays before dispatch, reopens afterward, and holds the full flow", async () => {
        const events: string[] = [];
        const { runtime, isInteractive } = fakeRuntime([status(), page([summary()]), message(), status(), page([summary()])]);
        const { context, custom } = plannedContext([[ENTER], [ENTER], [ENTER], [ESC]], events);
        const dispatch = vi.fn(async (args: string) => {
            expect(events.at(-1)).toBe("disposed");
            expect(isInteractive()).toBe(true);
            expect(args).toBe("thread thread-1");
            events.push("dispatch");
        });
        await showTeamDashboard(runtime, context, dispatch);
        expect(custom).toHaveBeenCalledTimes(4);
        expect(dispatch).toHaveBeenCalledOnce();
        expect(isInteractive()).toBe(false);
    });
    it("stops after leave or binding replacement", async () => {
        const leaving = fakeRuntime([status(), page()]);
        const leaveCtx = plannedContext([[DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER]]).context;
        const dispatch = vi.fn(async () => { leaving.runtime.binding = undefined; });
        await showTeamDashboard(leaving.runtime, leaveCtx, dispatch);
        expect(dispatch).toHaveBeenCalledWith("leave");
        expect(leaving.client.call).toHaveBeenCalledTimes(2);

        const replaced = fakeRuntime([status(), page()]);
        const replaceCtx = plannedContext([["r"]]).context;
        let checks = 0;
        replaced.runtime.isCurrentBinding = vi.fn(() => ++checks === 1);
        await showTeamDashboard(replaced.runtime, replaceCtx, vi.fn());
        expect(replaced.client.call).toHaveBeenCalledTimes(2);
    });
});
