import { truncateHead, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AutomaticDelivery, PEER_BATCH_TYPE } from "../../src/coordination/automation.ts";
import { TeamClient, controlCall, type ControlOperations, type OperationParams, type OperationResult, type WorkerHello } from "../../src/coordination/client.ts";
import { deliverOne, findPersistedEntry, PEER_MESSAGE_TYPE, reconcileDelivery, type DeliveryAdapter } from "../../src/coordination/delivery.ts";
import { ensureBroker } from "../../src/coordination/managed.ts";
import { teamPaths } from "../../src/coordination/paths.ts";
import { HEARTBEAT_MS, safeText, type Binding, type Credential, type Message, type Page, type Runtime, type Status } from "../../src/coordination/protocol.ts";
import { TeamNavigationCache, type TeamNavigationSnapshot } from "../../src/coordination/navigation.ts";
import { INSPECT_ENTRY_TYPE as INSPECT, MEMBERSHIP_ENTRY_TYPE as MEMBERSHIP, WIDGET_ID as WIDGET } from "./constants.ts";
import { renderWidget } from "./rendering.ts";

function bounded(value: string): string {
    const truncated = truncateHead(safeText(value), { maxBytes: 40 * 1024, maxLines: 1800 });
    return truncated.content + (truncated.truncated ? "\n[Truncated. Retrieve a specific message with team_read messageId or /team read; use smaller pages/cursors for history.]" : "");
}
export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function hello(c: Credential): WorkerHello { return { roomId: c.roomId, participantId: c.participantId, sessionId: c.sessionId, token: c.token }; }

/** Owns session-scoped transport, timers, delivery state, and epoch fencing. */
export class CoordinationRuntime {
    private _binding?: Binding;
    private credential?: Credential;
    private _client?: TeamClient;
    private ctx?: ExtensionContext;
    private _status?: Status;
    private epoch = 0;
    private timer?: ReturnType<typeof setInterval>;
    private connecting = false;
    private refreshing = false;
    private transportAbort = new AbortController();
    private retryAt = 0;
    private reconnectDelay = 1000;
    private runtime: Runtime = "unknown";
    private uiPrompts = 0;
    private interactiveFlows = 0;
    private readonly navigation = new TeamNavigationCache();
    private locallyPaused = false;
    private deliveryBusy = false;
    private joinInFlight?: Promise<boolean>;
    private automatic?: AutomaticDelivery;
    private _lastError = "";
    private readonly listeners = new Set<() => void>();

    constructor(private readonly pi: ExtensionAPI) {}
    get binding(): Binding | undefined { return this._binding; }
    get client(): TeamClient | undefined { return this._client; }
    get status(): Status | undefined { return this._status; }
    get lastError(): string { return this._lastError; }
    get automaticHeld(): boolean { return this.automatic?.isHeld ?? false; }
    get localDeliveryPaused(): boolean { return this.locallyPaused || this.automaticHeld; }
    navigationSnapshot(): TeamNavigationSnapshot { return this.navigation.snapshot(); }
    rememberStatus(status: Status): void { if (this._binding) this.navigation.rememberStatus(status, this._binding.participantId); }
    rememberMessage(message: Message): void { if (this._binding) this.navigation.rememberMessage(message, this._binding.participantId); }
    rememberPage(page: Page): void { if (this._binding) this.navigation.rememberPage(page, this._binding.participantId); }
    current(context: ExtensionContext): boolean { return !!this.ctx && this.ctx.sessionManager.getSessionId() === context.sessionManager.getSessionId(); }
    isCurrentBinding(binding: Binding): boolean {
        return this._binding === binding && this.ctx?.sessionManager.getSessionId() === binding.sessionId;
    }
    private widget(): void {
        renderWidget(this.ctx, this._binding, this._status, !!this._client, this.automaticHeld);
        for (const listener of this.listeners) {
            try { listener(); } catch { /* Dashboard rendering must not break broker refresh. */ }
        }
    }
    subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

    async refresh(): Promise<void> {
        const client = this._client, binding = this._binding, epoch = this.epoch;
        if (!client || !binding || this.refreshing) return;
        this.refreshing = true;
        try {
            const next = await client.call("status", { roomId: binding.roomId });
            if (!next?.room || !Array.isArray(next.participants)) throw new Error("Malformed team status response.");
            if (epoch !== this.epoch || client !== this._client) return;
            this._status = next;
            this.navigation.rememberStatus(next, binding.participantId);
            this.locallyPaused = !!next.participants.find((participant) => participant.id === binding.participantId)?.paused;
            this._lastError = "";
            this.widget();
            this.automatic?.kick();
        } catch (error) {
            if (epoch === this.epoch && client === this._client) {
                this._lastError = errorText(error);
                this._client = undefined;
                await client.close();
                this.widget();
            }
        } finally {
            if (epoch === this.epoch) this.refreshing = false;
        }
    }

    private async connectWorker(): Promise<void> {
        const credential = this.credential, epoch = this.epoch;
        if (!credential || this._client || this.connecting || Date.now() < this.retryAt) return;
        this.connecting = true;
        try {
            await ensureBroker(teamPaths());
            if (epoch !== this.epoch || credential !== this.credential) return;
            const connected = await TeamClient.connect(teamPaths().socket, hello(credential), 3000, this.transportAbort.signal);
            if (epoch !== this.epoch || credential !== this.credential) { await connected.close(); return; }
            this._client = connected;
            this.reconnectDelay = 1000;
            this.retryAt = 0;
            connected.onChanged = (room) => { if (room === this._binding?.roomId && epoch === this.epoch) void this.refresh(); };
            connected.onClose = () => {
                if (epoch !== this.epoch || this._client !== connected) return;
                this._client = undefined;
                this._lastError = "Broker disconnected; cached presence is stale. Pending messages remain stored.";
                this.widget();
            };
            await connected.call("heartbeat", { roomId: credential.roomId, runtime: this.runtime });
            await this.refresh();
        } catch (error) {
            if (epoch === this.epoch) {
                this._lastError = errorText(error);
                const broken = this._client;
                this._client = undefined;
                await broken?.close();
                this.retryAt = Date.now() + this.reconnectDelay + Math.floor(Math.random() * 300);
                this.reconnectDelay = Math.min(30_000, this.reconnectDelay * 2);
                this.widget();
            }
        } finally {
            if (epoch === this.epoch) this.connecting = false;
        }
    }

    private start(): void {
        if (!this.automatic && this._binding) {
            const binding = this._binding, epoch = this.epoch;
            this.automatic = new AutomaticDelivery({
                binding,
                transport: () => epoch === this.epoch ? this._client : undefined,
                ready: () => epoch === this.epoch && !!this.ctx && !!this._client && this.ctx.isIdle() && this.runtime === "idle" && this.uiPrompts === 0 && this.interactiveFlows === 0 && !this.ctx.hasPendingMessages?.() && !this.deliveryBusy && !this.locallyPaused && !this._status?.room.paused,
                insert: (content, details) => this.pi.sendMessage({ customType: PEER_BATCH_TYPE, content, details, display: true }, { deliverAs: "followUp", triggerTurn: true }),
                persistedEntry: (id) => findPersistedEntry(epoch === this.epoch ? this.ctx?.sessionManager.getSessionFile() : undefined, binding, id),
                notify: (message) => { if (epoch === this.epoch) this.ctx?.ui.notify(message, "warning"); },
                changed: () => { if (epoch === this.epoch) void this.refresh(); },
            });
        }
        if (this.timer) return;
        this.timer = setInterval(() => {
            if (!this._client) { void this.connectWorker(); return; }
            const client = this._client, binding = this._binding;
            if (binding) void client.call("heartbeat", { roomId: binding.roomId, runtime: this.runtime }).then(() => this.refresh()).catch(() => {
                if (this._client === client) { this._client = undefined; void client.close(); this.widget(); }
            });
        }, HEARTBEAT_MS);
        this.timer.unref();
    }

    requireClient(roomId?: string): { client: TeamClient; binding: Binding } {
        if (!this._binding) throw new Error("Not enrolled. Ask the user to run /team join <room> --name <name> --role <role>.");
        if (roomId && roomId !== this._binding.roomId) throw new Error("Wrong team room ID. Use team_status to inspect this session's enrollment; cross-room routing is forbidden.");
        if (!this._client) throw new Error(this._lastError || "Broker reconnecting automatically; coding can continue. Retry shortly.");
        return { client: this._client, binding: this._binding };
    }
    inspect(text: string): void { this.pi.appendEntry(INSPECT, { text: bounded(text) }); }
    async confirm(context: ExtensionCommandContext, title: string, detail: string): Promise<boolean> {
        if (context.mode !== "tui") throw new Error("Human coordination controls currently require interactive TUI confirmation. Request remains pending; no permission granted.");
        const epoch = this.epoch;
        const approved = await context.ui.confirm(title, detail);
        if (epoch !== this.epoch || !this.current(context)) throw new Error("Session changed during confirmation; no new control action was sent.");
        return approved;
    }
    adapter(context: ExtensionContext, binding: Binding): DeliveryAdapter {
        const epoch = this.epoch;
        return {
            binding,
            isReady: () => epoch === this.epoch && this.current(context) && !!this._client && context.isIdle() && !this.locallyPaused && !this._status?.room.paused,
            insert: (content, details) => this.pi.sendMessage({ customType: PEER_MESSAGE_TYPE, content, details, display: true }, { deliverAs: "followUp", triggerTurn: false }),
            persistedEntry: (messageId) => findPersistedEntry(context.sessionManager.getSessionFile(), binding, messageId),
        };
    }
    async withDelivery<T>(fn: () => Promise<T>): Promise<T> {
        if (this.deliveryBusy) throw new Error("Another manual delivery/recovery is in progress.");
        this.deliveryBusy = true;
        try { return await fn(); } finally { this.deliveryBusy = false; }
    }
    async withInteractiveFlow<T>(fn: () => Promise<T>): Promise<T> {
        this.interactiveFlows++;
        this.runtime = "waiting-for-user";
        try { return await fn(); }
        finally {
            this.interactiveFlows = Math.max(0, this.interactiveFlows - 1);
            if (!this.interactiveFlows && this.ctx) {
                this.runtime = this.uiPrompts ? "waiting-for-user" : this.ctx.isIdle() ? "idle" : "working";
                this.automatic?.kick();
            }
        }
    }
    deliver(client: TeamClient, context: ExtensionContext, binding: Binding, messageId: string): Promise<string> { return deliverOne(client, this.adapter(context, binding), messageId); }
    reconcile(client: TeamClient, context: ExtensionContext, binding: Binding, delivery: Message["deliveries"][number]): Promise<boolean> { return reconcileDelivery(client, this.adapter(context, binding), delivery); }
    control<Name extends keyof ControlOperations & string>(operation: Name, params: OperationParams<ControlOperations, Name>): Promise<OperationResult<ControlOperations, Name>> { return controlCall(teamPaths(), operation, params); }

    join(context: ExtensionCommandContext, room: string, name: string, role: string, rejoin: boolean): Promise<boolean> {
        if (this.joinInFlight) return Promise.reject(new Error("Another team join is already in progress."));
        const task = this.performJoin(context, room, name, role, rejoin);
        this.joinInFlight = task;
        return task.finally(() => { if (this.joinInFlight === task) this.joinInFlight = undefined; });
    }
    private async performJoin(context: ExtensionCommandContext, room: string, name: string, role: string, rejoin: boolean): Promise<boolean> {
        const epoch = this.epoch;
        await ensureBroker(teamPaths());
        if (epoch !== this.epoch || !this.current(context)) throw new Error("Session changed during startup; no enrollment sent.");
        const joined = await controlCall(teamPaths(), "join", { room, name, role, sessionId: context.sessionManager.getSessionId(), rejoin });
        if (epoch !== this.epoch || !this.current(context)) return false;
        this.credential = joined;
        this.navigation.reset(joined.roomId);
        const { token: _token, ...binding } = joined;
        this._binding = binding;
        this.pi.appendEntry(MEMBERSHIP, { binding });
        this.retryAt = 0;
        this.start();
        await this.connectWorker();
        return true;
    }
    private clearEnrollment(): void {
        this.automatic?.dispose();
        this.automatic = undefined;
        this.epoch++;
        this.transportAbort.abort();
        this.transportAbort = new AbortController();
        this.credential = undefined;
        this._binding = undefined;
        this._status = undefined;
        this.navigation.reset();
        this.interactiveFlows = 0;
        this.connecting = false;
        this.refreshing = false;
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }
    detachOffline(): void { this.clearEnrollment(); this.pi.appendEntry(MEMBERSHIP, { binding: null }); this.widget(); }
    async leave(client: TeamClient, binding: Binding): Promise<void> {
        await this.control("leave", { roomId: binding.roomId, participantId: binding.participantId });
        this.clearEnrollment();
        this._client = undefined;
        this.pi.appendEntry(MEMBERSHIP, { binding: null });
        await client.close();
        this.widget();
    }
    setLocalPaused(paused: boolean): void { this.locallyPaused = paused; }
    resumeAutomatic(): void { this.automatic?.resume(); }

    async sessionStart(event: { reason: string }, context: ExtensionContext): Promise<void> {
        if (this.ctx && this.ctx.sessionManager.getSessionId() !== context.sessionManager.getSessionId()) {
            const staleClient = this._client;
            this._client = undefined;
            this.clearEnrollment();
            await staleClient?.close();
        }
        this.ctx = context;
        this.runtime = context.isIdle() ? "idle" : "working";
        if (event.reason !== "reload") return;
        const latest = [...context.sessionManager.getEntries()].reverse().find((entry) => entry.type === "custom" && entry.customType === MEMBERSHIP);
        if (latest?.type !== "custom") return;
        const saved = latest.data as { binding?: Binding } | undefined;
        if (!saved?.binding || saved.binding.sessionId !== context.sessionManager.getSessionId()) return;
        const epoch = this.epoch;
        try {
            await ensureBroker(teamPaths());
            if (epoch !== this.epoch || !this.current(context)) return;
            const recovered = await controlCall(teamPaths(), "restore", { roomId: saved.binding.roomId, participantId: saved.binding.participantId, sessionId: saved.binding.sessionId });
            if (epoch !== this.epoch) return;
            this.credential = recovered;
            this.navigation.reset(recovered.roomId);
            const { token: _token, ...binding } = recovered;
            this._binding = binding;
            this.start();
            await this.connectWorker();
        } catch (error) {
            if (epoch === this.epoch && this.current(context)) context.ui.notify(`Team reload detached: ${errorText(error)} Explicitly rejoin to recover the mailbox.`, "warning");
        }
    }
    async shutdown(): Promise<void> {
        // Let an explicitly confirmed join finish before invalidating its epoch, then detach normally.
        await this.joinInFlight?.catch(() => false);
        this.automatic?.dispose();
        this.automatic = undefined;
        this.epoch++;
        this.transportAbort.abort();
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        const client = this._client;
        this.ctx?.ui.setWidget(WIDGET, undefined);
        this.ctx = undefined;
        this._client = undefined;
        this.credential = undefined;
        this._binding = undefined;
        this._status = undefined;
        this.navigation.reset();
        this.uiPrompts = 0;
        this.interactiveFlows = 0;
        this.connecting = false;
        this.refreshing = false;
        await client?.close();
    }
    agentStarted(context: ExtensionContext, signal?: AbortSignal): void { if (this.current(context)) { this.ctx = context; this.runtime = this.interactiveFlows ? "waiting-for-user" : "working"; this.automatic?.agentStarted(signal); } }
    agentEnded(context: ExtensionContext, messages: readonly { role: string; stopReason?: string }[]): void { if (this.current(context)) this.automatic?.agentEnded(messages); }
    async agentSettled(context: ExtensionContext): Promise<void> { if (this.current(context)) { this.ctx = context; this.runtime = this.uiPrompts || this.interactiveFlows ? "waiting-for-user" : context.isIdle() ? "idle" : "working"; await this.automatic?.settled(); } }
    promptStarted(context: ExtensionContext): void { if (this.current(context)) { this.uiPrompts++; this.runtime = "waiting-for-user"; } }
    promptEnded(context: ExtensionContext): void { if (this.current(context)) { this.uiPrompts = Math.max(0, this.uiPrompts - 1); this.runtime = this.uiPrompts || this.interactiveFlows ? "waiting-for-user" : context.isIdle() ? "idle" : "working"; if (!this.interactiveFlows) this.automatic?.kick(); } }
}
