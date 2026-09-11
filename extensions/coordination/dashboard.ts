import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
    Container,
    Key,
    matchesKey,
    SelectList,
    Text,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
    type Component,
    type SelectItem,
    type TUI,
} from "@earendil-works/pi-tui";
import { safeText, type Binding, type Message, type MessageSummary, type Page, type Status } from "../../src/coordination/protocol.ts";
import { CoordinationRuntime, errorText } from "./runtime.ts";

export type DashboardIntent =
    | { kind: "close" }
    | { kind: "refresh"; history?: boolean; loadMore?: boolean }
    | { kind: "message"; messageId: string }
    | { kind: "participant"; participantId: string }
    | { kind: "thread"; threadId: string }
    | { kind: "command"; args: string };

export interface DashboardMessage {
    id: string;
    threadId: string;
    type: Message["type"];
    subject: string;
    authorName: string;
    sequence: number;
    createdAt: number;
    threadState: Message["thread_state"];
}
export interface DashboardOverviewState {
    status?: Status;
    messages: readonly DashboardMessage[];
    nextCursor: number | null;
    history: boolean;
    statusError?: string;
    inboxError?: string;
}

const overlay = { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "80%", margin: 1 } } as const;
const MAX_LABEL_CHARACTERS = 120;
const MAX_DASHBOARD_MESSAGES = 100;
const MAX_DASHBOARD_MESSAGE_BYTES = 64 * 1024;

function clean(value: string): string {
    return Array.from(safeText(value).replace(/\s+/g, " ").trim()).slice(0, MAX_LABEL_CHARACTERS).join("");
}
function selectStyle(theme: Theme) {
    return {
        selectedPrefix: (text: string) => theme.fg("accent", text),
        selectedText: (text: string) => theme.fg("accent", text),
        description: (text: string) => theme.fg("muted", text),
        scrollInfo: (text: string) => theme.fg("dim", text),
        noMatch: (text: string) => theme.fg("warning", text),
    };
}
function frame(theme: Theme, title: string, body: Component[], footer: string): Container {
    const box = new Container();
    box.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    box.addChild(new Text(theme.fg("accent", theme.bold(clean(title))), 1, 0));
    for (const child of body) box.addChild(child);
    box.addChild(new Text(theme.fg("dim", footer), 1, 0));
    box.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    return box;
}
function boundedRender(component: Component, width: number): string[] {
    if (width <= 0) return [];
    return component.render(width).map((line) => visibleWidth(line) > width ? truncateToWidth(line, width, "") : line);
}
function listComponent(container: Container, list: SelectList, tui: Pick<TUI, "requestRender">, done: (intent: DashboardIntent) => void): Component {
    return {
        render: (width) => boundedRender(container, width),
        invalidate: () => container.invalidate(),
        handleInput(data) {
            if (matchesKey(data, Key.ctrl("c"))) { done({ kind: "close" }); return; }
            if (data === "r" || data === "R") { done({ kind: "refresh" }); return; }
            list.handleInput(data);
            tui.requestRender();
        },
    };
}
function actionItems(state: DashboardOverviewState): SelectItem[] {
    const items: SelectItem[] = state.messages.map((message) => ({
        value: `message:${message.id}`,
        label: clean(message.subject || "Untitled message"),
        description: clean(`${message.authorName} · ${message.type} · ${message.id}`),
    }));
    if (!state.messages.length) items.push({ value: "refresh", label: state.history ? "No inbox history" : "Inbox is empty", description: "Refresh this view" });
    if (state.nextCursor !== null) items.push({ value: "more", label: "Load more", description: `Continue after cursor ${state.nextCursor}` });
    for (const participant of state.status?.participants ?? []) items.push({
        value: `participant:${participant.id}`,
        label: `Participant · ${clean(participant.name)}`,
        description: clean(`${participant.presence} · ${participant.role} · ${participant.pending} pending · ${participant.needsReply} need reply · ${participant.id}`),
    });
    items.push(
        { value: "refresh", label: "Refresh", description: "Fetch status and inbox" },
        { value: "history", label: state.history ? "Show active inbox" : "Show inbox history", description: "Inspection only; does not acknowledge or deliver" },
        { value: "command:pause local", label: "Pause local delivery", description: "Existing confirmation applies" },
        { value: "command:resume local", label: "Resume local delivery", description: "Existing confirmation applies" },
        { value: "command:pause room", label: "Pause room delivery", description: "Existing confirmation applies" },
        { value: "command:resume room", label: "Resume room delivery", description: "Existing confirmation applies" },
        { value: "command:leave", label: "Leave team", description: "Existing confirmation applies" },
        { value: "close", label: "Close dashboard", description: "No action" },
    );
    return items;
}
function intent(value: string, history = false): DashboardIntent {
    if (value === "close") return { kind: "close" };
    if (value === "refresh") return { kind: "refresh", history };
    if (value === "history") return { kind: "refresh", history: !history };
    if (value === "more") return { kind: "refresh", history, loadMore: true };
    if (value.startsWith("message:")) return { kind: "message", messageId: value.slice(8) };
    if (value.startsWith("participant:")) return { kind: "participant", participantId: value.slice(12) };
    if (value.startsWith("thread:")) return { kind: "thread", threadId: value.slice(7) };
    return { kind: "command", args: value.slice(8) };
}

/** Exported for deterministic width/key behavior tests; it performs no I/O. */
export function createOverviewComponent(
    tui: Pick<TUI, "requestRender">,
    theme: Theme,
    done: (intent: DashboardIntent) => void,
    state: DashboardOverviewState,
): Component {
    const room = state.status?.room.name ?? "Team";
    const roomId = state.status?.room.id;
    const header = state.status
        ? `${state.status.participants.filter((participant) => participant.presence === "connected").length}/${state.status.participants.length} connected · ${state.status.attention} need attention · ${state.status.room.paused ? "ROOM PAUSED" : "active"}`
        : "Status unavailable";
    const list = new SelectList(actionItems(state), 12, selectStyle(theme));
    list.onSelect = (item) => done(intent(item.value, state.history));
    list.onCancel = () => done({ kind: "close" });
    const body: Component[] = [new Text(theme.fg("muted", header), 1, 0)];
    if (state.statusError) body.push(new Text(theme.fg("warning", `Status: ${clean(state.statusError)}`), 1, 0));
    if (state.inboxError) body.push(new Text(theme.fg("warning", `Inbox: ${clean(state.inboxError)}`), 1, 0));
    body.push(list);
    return listComponent(frame(theme, `Team dashboard · ${room}${roomId ? ` · ${roomId}` : ""}`, body, "↑↓ navigate • enter select • r refresh • esc close"), list, tui, done);
}

async function overview(runtime: CoordinationRuntime, ctx: ExtensionCommandContext, state: DashboardOverviewState): Promise<DashboardIntent> {
    let unsubscribe: (() => void) | undefined;
    try {
        return (await ctx.ui.custom<DashboardIntent>((tui, theme, _keys, done) => {
            unsubscribe = runtime.subscribe(() => tui.requestRender());
            return createOverviewComponent(tui, theme, done, state);
        }, overlay)) ?? { kind: "close" };
    } finally {
        unsubscribe?.();
    }
}

/** Scrollable full-message view. Enter disposes it before the action menu opens. */
export class MessageDetailComponent implements Component {
    private scrollOffset = 0;
    private pageSize = 10;
    constructor(
        private readonly tui: Pick<TUI, "requestRender">,
        private readonly theme: Theme,
        private readonly message: Message,
        private readonly done: (intent: DashboardIntent) => void,
    ) {}
    handleInput(data: string): void {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.done({ kind: "refresh" }); return; }
        if (matchesKey(data, Key.enter)) { this.done({ kind: "message", messageId: this.message.id }); return; }
        if (matchesKey(data, Key.up)) this.scrollOffset = Math.max(0, this.scrollOffset - 1);
        else if (matchesKey(data, Key.down)) this.scrollOffset++;
        else if (matchesKey(data, Key.pageUp)) this.scrollOffset = Math.max(0, this.scrollOffset - this.pageSize);
        else if (matchesKey(data, Key.pageDown)) this.scrollOffset += this.pageSize;
        else return;
        this.tui.requestRender();
    }
    render(width: number): string[] {
        if (width <= 0) return [];
        const innerWidth = Math.max(1, width - 2);
        const bodyLines = wrapTextWithAnsi(safeText(this.message.body), innerWidth);
        this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, bodyLines.length - 1));
        const visible = bodyLines.slice(this.scrollOffset, this.scrollOffset + this.pageSize);
        const remaining = Math.max(0, bodyLines.length - this.scrollOffset - visible.length);
        const container = frame(this.theme, this.message.subject || "Message", [
            new Text(this.theme.fg("muted", clean(`${this.message.author_name} · ${this.message.type} · ${this.message.id}`)), 1, 0),
            new Text(visible.join("\n") || "(empty message)", 1, 0),
            new Text(this.theme.fg("dim", `line ${bodyLines.length ? this.scrollOffset + 1 : 0}/${bodyLines.length} · ${remaining} below`), 1, 0),
        ], "↑↓/PgUp/PgDn scroll • enter actions • esc back");
        return boundedRender(container, width);
    }
    invalidate(): void {}
}

async function messageDetail(ctx: ExtensionCommandContext, message: Message): Promise<DashboardIntent> {
    return (await ctx.ui.custom<DashboardIntent>((tui, theme, _keys, done) => new MessageDetailComponent(tui, theme, message, done), overlay)) ?? { kind: "refresh" };
}
interface MessageActions {
    id: string;
    threadId: string;
    subject: string;
    threadState: Message["thread_state"];
    ownState?: Message["deliveries"][number]["state"];
    hasDeliveries: boolean;
}
function actionMetadata(message: Message, participantId: string): MessageActions {
    return {
        id: message.id,
        threadId: message.thread_id,
        subject: clean(message.subject),
        threadState: message.thread_state,
        ownState: message.deliveries.find((delivery) => delivery.recipient_id === participantId)?.state,
        hasDeliveries: message.deliveries.length > 0,
    };
}
async function messageActions(ctx: ExtensionCommandContext, message: MessageActions): Promise<DashboardIntent> {
    return (await ctx.ui.custom<DashboardIntent>((tui, theme, _keys, done) => {
        const actions: SelectItem[] = [
            { value: `thread:${message.threadId}`, label: "View thread", description: message.threadId },
            ...(message.ownState === "pending" ? [{ value: `command:deliver ${message.id}`, label: "Deliver", description: "Manual local delivery" }] : []),
            ...(["claimed", "queued", "uncertain"].includes(message.ownState ?? "") ? [{ value: `command:reconcile ${message.id}`, label: "Reconcile", description: "Check persisted receipt" }] : []),
            ...(message.ownState === "uncertain" ? [{ value: `command:retry ${message.id}`, label: "Retry uncertainty", description: "Existing confirmation applies" }] : []),
            ...(message.hasDeliveries ? [{ value: `command:review ${message.id}`, label: "Review delivery", description: "Existing human review UI" }] : []),
            ...(message.threadState === "open" ? [{ value: `command:resolve ${message.threadId}`, label: "Resolve thread", description: "Existing confirmation applies" }] : []),
            { value: "refresh", label: "Back", description: "Return to dashboard" },
        ];
        const list = new SelectList(actions, Math.min(actions.length, 8), selectStyle(theme));
        list.onSelect = (item) => done(intent(item.value));
        list.onCancel = () => done({ kind: "refresh" });
        return listComponent(frame(theme, message.subject || "Message actions", [list], "enter select • esc back"), list, tui, done);
    }, overlay)) ?? { kind: "refresh" };
}
async function participantDetail(ctx: ExtensionCommandContext, status: Status): Promise<void> {
    await ctx.ui.custom<void>((tui, theme, _keys, done) => {
        const participant = status.participants[0];
        const list = new SelectList([{ value: "back", label: "Back" }], 1, selectStyle(theme));
        list.onSelect = () => done();
        list.onCancel = () => done();
        return listComponent(frame(theme, participant ? `Participant · ${participant.name}` : "Participant", [
            new Text(safeText(participant ? `${participant.role} · ${participant.presence}\n\n${participant.summary || "No work summary."}\n\n${participant.blocker || "No blocker."}` : "Unavailable"), 1, 0),
            list,
        ], "enter/esc back"), list, tui, () => done());
    }, overlay);
}

function current(runtime: CoordinationRuntime, binding: Binding): boolean {
    return runtime.isCurrentBinding(binding);
}
function project(message: MessageSummary): DashboardMessage {
    return {
        id: message.id,
        threadId: message.thread_id,
        type: message.type,
        subject: clean(message.subject),
        authorName: clean(message.author_name),
        sequence: message.sequence,
        createdAt: message.created_at,
        threadState: message.thread_state,
    };
}
function dedupe(messages: Map<string, DashboardMessage>, page: Page): void {
    for (const message of page.items) messages.set(message.id, project(message));
    let values = sorted(messages);
    while (values.length > MAX_DASHBOARD_MESSAGES || Buffer.byteLength(JSON.stringify(values)) > MAX_DASHBOARD_MESSAGE_BYTES) {
        const oldest = values.shift();
        if (!oldest) return;
        messages.delete(oldest.id);
        values = sorted(messages);
    }
}
function sorted(messages: Map<string, DashboardMessage>): DashboardMessage[] {
    return [...messages.values()].sort((a, b) => a.createdAt - b.createdAt || a.sequence - b.sequence || a.id.localeCompare(b.id));
}

/** Explicit, non-polling dashboard. Broker state remains authoritative. */
export async function showTeamDashboard(runtime: CoordinationRuntime, ctx: ExtensionCommandContext, dispatch: (args: string) => Promise<void>): Promise<void> {
    await runtime.withInteractiveFlow(async () => {
        const initial = runtime.binding;
        if (!initial) throw new Error("Not enrolled. Join a team before opening the dashboard.");
        let state: DashboardOverviewState = { messages: [], nextCursor: null, history: false };
        let loaded = false;
        const messages = new Map<string, DashboardMessage>();

        while (current(runtime, initial)) {
            const connection = runtime.requireClient();
            if (connection.binding !== initial) return;
            if (!loaded) {
                messages.clear();
                const [statusResult, pageResult] = await Promise.allSettled([
                    connection.client.call("status", { roomId: initial.roomId }),
                    connection.client.call("read", { roomId: initial.roomId, cursor: 0, history: state.history }),
                ]);
                if (!current(runtime, initial)) return;
                const status = statusResult.status === "fulfilled" ? statusResult.value : undefined;
                const page = pageResult.status === "fulfilled" ? pageResult.value : undefined;
                if (status) runtime.rememberStatus(status);
                if (page && "items" in page) { runtime.rememberPage(page); dedupe(messages, page); }
                state = {
                    status,
                    messages: sorted(messages),
                    nextCursor: page && "items" in page ? page.nextCursor : null,
                    history: state.history,
                    ...(statusResult.status === "rejected" ? { statusError: errorText(statusResult.reason) } : {}),
                    ...(pageResult.status === "rejected" ? { inboxError: errorText(pageResult.reason) } : {}),
                };
                loaded = true;
            }

            const selected = await overview(runtime, ctx, state);
            if (!current(runtime, initial) || selected.kind === "close") return;
            if (selected.kind === "refresh") {
                const historyChanged = selected.history !== undefined && selected.history !== state.history;
                state = { ...state, history: selected.history ?? state.history };
                if (selected.loadMore && !historyChanged && state.nextCursor !== null) {
                    try {
                        const page = await connection.client.call("read", { roomId: initial.roomId, cursor: state.nextCursor, history: state.history });
                        if (!current(runtime, initial) || !("items" in page)) return;
                        runtime.rememberPage(page);
                        dedupe(messages, page);
                        state = { ...state, messages: sorted(messages), nextCursor: page.nextCursor, inboxError: undefined };
                    } catch (error) {
                        if (!current(runtime, initial)) return;
                        state = { ...state, inboxError: errorText(error) };
                    }
                } else loaded = false;
                continue;
            }
            if (selected.kind === "command") {
                await dispatch(selected.args);
                if (!current(runtime, initial)) return;
                loaded = false;
                continue;
            }
            if (selected.kind === "thread") {
                await dispatch(`thread ${selected.threadId}`);
                if (!current(runtime, initial)) return;
                loaded = false;
                continue;
            }
            if (selected.kind === "participant") {
                try {
                    const detail = await connection.client.call("status", { roomId: initial.roomId, participantId: selected.participantId });
                    if (!current(runtime, initial)) return;
                    runtime.rememberStatus(detail);
                    await participantDetail(ctx, detail);
                } catch (error) {
                    if (!current(runtime, initial)) return;
                    state = { ...state, statusError: errorText(error) };
                }
                loaded = false;
                continue;
            }
            try {
                let fullMessage: Message | undefined = await connection.client.call("read", { roomId: initial.roomId, messageId: selected.messageId });
                if (!current(runtime, initial) || "items" in fullMessage) return;
                runtime.rememberMessage(fullMessage);
                const detail = await messageDetail(ctx, fullMessage);
                if (!current(runtime, initial)) return;
                const actions = detail.kind === "message" ? actionMetadata(fullMessage, initial.participantId) : undefined;
                fullMessage = undefined;
                if (actions) {
                    const action = await messageActions(ctx, actions);
                    if (!current(runtime, initial)) return;
                    if (action.kind === "command") await dispatch(action.args);
                    else if (action.kind === "thread") await dispatch(`thread ${action.threadId}`);
                }
            } catch (error) {
                if (!current(runtime, initial)) return;
                state = { ...state, inboxError: errorText(error) };
            }
            loaded = false;
        }
    });
}
