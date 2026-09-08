import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createSubagentWidget } from "../../extensions/orchestration/subagent/widget.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import coordination from "../../extensions/coordination/index.ts";
import { startBroker } from "../../src/coordination/broker.ts";
import { TeamClient, controlCall } from "../../src/coordination/client.ts";
import { teamPaths } from "../../src/coordination/paths.ts";
import { type Credential, type Message, type Status } from "../../src/coordination/protocol.ts";

type Entry = { type: string; customType?: string; data?: unknown; details?: unknown; id?: string; content?: string };
type Listener = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); vi.unstubAllEnvs(); });
function fakeSession(sessionId: string, sessionFile: string, entries: Entry[] = []) {
    const events = new Map<string, Listener>();
    const tools = new Map<string, ToolDefinition>();
    let command: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    let idle = true, approval = true;
    const sendMessage = vi.fn((message: { customType: string; content: string; details: unknown }, _options: unknown) => {
        const entry = { type: "custom_message", id: `entry-${entries.length}`, ...message };
        entries.push(entry); appendFileSync(sessionFile, JSON.stringify(entry) + "\n");
    });
    const appendEntry = vi.fn((customType: string, data: unknown) => {
        const entry = { type: "custom", customType, data };
        entries.push(entry); appendFileSync(sessionFile, JSON.stringify(entry) + "\n");
    });
    const notify = vi.fn(); const setWidget = vi.fn();
    const context = {
        mode: "tui", hasUI: true, isIdle: () => idle,
        sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile, getEntries: () => entries },
        ui: { setWidget, notify, confirm: async () => approval, select: async () => undefined, editor: async () => undefined },
    } as unknown as ExtensionCommandContext;
    const pi = {
        on(name: string, handler: Listener) { events.set(name, handler); },
        registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
        registerCommand(_name: string, definition: { handler: typeof command }) { command = definition.handler; },
        registerEntryRenderer() {}, registerMessageRenderer() {}, sendMessage, appendEntry,
    } as unknown as ExtensionAPI;
    coordination(pi);
    const emit = async (name: string, event: Record<string, unknown> = {}) => events.get(name)?.(event, context);
    cleanups.push(() => emit("session_shutdown", { reason: "quit" }));
    const execute = (name: string, params: Record<string, unknown>) => tools.get(name)!.execute("call-id", params, undefined, undefined, context);
    return { context, emit, entries, sendMessage, notify, setWidget, execute, command: (args: string) => command(args, context), setIdle(v: boolean) { idle = v; }, setApproval(v: boolean) { approval = v; } };
}
async function setup() {
    const root = mkdtempSync("/tmp/pi-team-ext-"); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    vi.stubEnv("PI_CODING_AGENT_DIR", root);
    const paths = teamPaths(), broker = await startBroker(paths); cleanups.push(() => broker.stop());
    const file = join(root, "app.jsonl"); writeFileSync(file, "");
    const app = fakeSession("app-session", file); await app.emit("session_start", { reason: "startup" });
    return { root, paths, broker, file, app };
}

describe("Pi extension lifecycle and manual-only boundaries", () => {
    it("factory/startup do not enroll, open sockets, or trigger model turns", async () => {
        const s = await setup();
        expect(s.app.sendMessage).not.toHaveBeenCalled();
        expect(s.broker.store.db.prepare("SELECT count(*) n FROM participants").get()?.n).toBe(0);
        await expect(s.app.execute("team_status", {})).rejects.toThrow(/Not enrolled/);
        await s.app.command("help"); expect(s.app.entries.length).toBe(1); // TUI-only inspection, not model input.
    });
    it("/team join works from a fresh directory without a prestarted broker or control key", async () => {
        const root = mkdtempSync("/tmp/pi-team-cold-");
        cleanups.push(() => rmSync(root, { recursive: true, force: true }));
        vi.stubEnv("PI_CODING_AGENT_DIR", root);
        const paths = teamPaths();
        cleanups.push(async () => {
            await controlCall(paths, "stop", {}).catch(() => {});
            await expect.poll(() => { return existsSync(paths.socket); }).toBe(false);
        });
        const file = join(root, "app.jsonl"); writeFileSync(file, "");
        const app = fakeSession("cold-session", file);
        await app.emit("session_start", { reason: "startup" });
        app.setApproval(false); await app.command("join catalog --name app --role worker");
        expect(existsSync(paths.control)).toBe(false);
        app.setApproval(true); await app.command("join catalog --name app --role worker");
        expect((await app.execute("team_status", {})).content[0]).toMatchObject({ text: expect.stringContaining("app (you)") });
        expect(app.sendMessage).not.toHaveBeenCalled();
    });
    it("declined or headless enrollment never grants authority", async () => {
        const s = await setup(); s.app.setApproval(false);
        await s.app.command("join catalog --name app --role worker");
        expect(s.broker.store.db.prepare("SELECT count(*) n FROM participants").get()?.n).toBe(0);
        s.app.context.mode = "print";
        await s.app.command("join catalog --name app --role worker");
        expect(s.app.notify).toHaveBeenLastCalledWith(expect.stringContaining("require interactive TUI"), "error");
    });
    it("joins, renders a bounded widget, reads without wakeups and manually inserts one message", async () => {
        const s = await setup(); await s.app.command("join catalog --name app --role worker");
        const b = await controlCall<Credential>(s.paths, "join", { room: "catalog", name: "backend", role: "worker", sessionId: "backend-session" });
        const client = await TeamClient.connect(s.paths.socket, { roomId: b.roomId, participantId: b.participantId, sessionId: b.sessionId, token: b.token }); cleanups.push(() => client.close());
        const status = await client.call<Status>("status", { roomId: b.roomId }); const app = status.participants.find((p) => p.name === "app")!;
        const m = await client.call<Message>("send", { roomId: b.roomId, idempotencyKey: "q", recipients: [app.id], type: "question", subject: "Null fields", body: "Can fields be null?" });
        await s.app.command("inbox"); await s.app.command(`read ${m.id}`);
        expect(s.app.sendMessage).not.toHaveBeenCalled();
        s.app.setIdle(false); await s.app.command(`deliver ${m.id}`);
        expect(s.app.notify).toHaveBeenLastCalledWith(expect.stringContaining("idle and unpaused"), "error");
        expect(s.app.sendMessage).not.toHaveBeenCalled();
        s.app.setIdle(true); await s.app.command(`deliver ${m.id}`);
        expect(s.app.sendMessage).toHaveBeenCalledOnce();
        expect(s.app.sendMessage.mock.calls[0][1]).toEqual({ deliverAs: "followUp", triggerTurn: false });
        const saved = await client.call<Message>("read", { roomId: b.roomId, messageId: m.id }); expect(saved.deliveries[0].state).toBe("recorded");
        const factory = [...s.app.setWidget.mock.calls].reverse().find((args) => typeof args[1] === "function")![1];
        for (const color of ["dark", "light"]) {
            const theme = {
                fg: (_key: string, text: string) => `\x1b[${color === "dark" ? 32 : 34}m${text}\x1b[0m`,
                bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
            };
            const component = factory({}, theme);
            for (const width of [0, 1, 3, 4, 12, 40, 80]) {
                const lines = component.render(width); expect(lines.length).toBeLessThanOrEqual(8);
                for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
                if (width >= 4) {
                    const plain = lines.map(stripVTControlCharacters);
                    expect(plain[0]).toMatch(/^╭─.*╮$/);
                    expect(plain.at(-1)).toBe(`╰${"─".repeat(width - 2)}╯`);
                    if (width >= 5) expect(plain.at(-1)).toBe(createSubagentWidget([])({}, theme).render(width).at(-1));
                    for (const line of plain.slice(1, -1)) expect(line).toMatch(/^│ .* │$/);
                    for (const line of lines) expect(visibleWidth(line)).toBe(width);
                }
            }
        }
        // Membership entries and status never persist credentials.
        expect(JSON.stringify(s.app.entries)).not.toContain('"token"');
    });
    it("automatic delivery waits for all nested user prompts to close", async () => {
        const s = await setup(); await s.app.command("join catalog --name app --role worker");
        const b = await controlCall<Credential>(s.paths, "join", { room: "catalog", name: "backend", role: "worker", sessionId: "backend-session" });
        const client = await TeamClient.connect(s.paths.socket, { roomId: b.roomId, participantId: b.participantId, sessionId: b.sessionId, token: b.token }); cleanups.push(() => client.close());
        const status = await client.call<Status>("status", { roomId: b.roomId });
        await s.app.emit("ui_prompt_start"); await s.app.emit("ui_prompt_start");
        await client.call("send", { roomId: b.roomId, idempotencyKey: "nested-ui", recipients: [status.participants.find((p) => p.name === "app")!.id], type: "question", subject: "UI", body: "Need input" });
        await s.app.emit("ui_prompt_end");
        await new Promise((r) => setTimeout(r, 300)); expect(s.app.sendMessage).not.toHaveBeenCalled();
        await s.app.emit("ui_prompt_end");
        await expect.poll(() => s.app.sendMessage.mock.calls.length).toBe(1);
        expect(s.app.sendMessage.mock.calls[0][1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
    });
    it("reload restores the same binding and session replacement never inherits enrollment", async () => {
        const s = await setup(); await s.app.command("join catalog --name app --role worker");
        await s.app.emit("session_shutdown", { reason: "reload" });
        // Wait for broker-side socket close; no live takeover is permitted.
        await expect.poll(() => s.broker.store.db.prepare("SELECT connection_id FROM participants WHERE name='app'").get()?.connection_id).toBeNull();
        const reloaded = fakeSession("app-session", s.file, s.app.entries);
        await reloaded.emit("session_start", { reason: "reload" });
        const status = await reloaded.execute("team_status", {}); expect(status.content[0]).toMatchObject({ text: expect.stringContaining("app (you)") });
        await reloaded.emit("session_shutdown", { reason: "fork" });
        const forkFile = join(s.root, "fork.jsonl"); writeFileSync(forkFile, "");
        for (const reason of ["new", "resume", "fork", "startup"]) {
            const replacement = fakeSession(`replacement-${reason}`, forkFile, s.app.entries);
            await replacement.emit("session_start", { reason });
            await expect(replacement.execute("team_status", {})).rejects.toThrow(/Not enrolled/);
        }
    });
    it("room-local pause/resume cannot start a model; unavailable sessions can detach", async () => {
        const s = await setup(); await s.app.command("join catalog --name app --role worker");
        await s.app.command("pause local"); expect(s.broker.store.db.prepare("SELECT paused FROM participants WHERE name='app'").get()?.paused).toBe(1);
        await s.app.command("resume local"); expect(s.broker.store.db.prepare("SELECT paused FROM participants WHERE name='app'").get()?.paused).toBe(0);
        await s.broker.stop(); await new Promise((r) => setTimeout(r, 20));
        await s.app.command("status");
        expect(JSON.stringify(s.app.entries)).toContain("cached presence STALE");
        await s.app.command("leave"); await expect(s.app.execute("team_status", {})).rejects.toThrow(/Not enrolled/);
        expect(s.app.sendMessage).not.toHaveBeenCalled();
    });
});
