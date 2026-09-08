import { afterEach, expect, it, vi } from "vitest";
import { TeamStore } from "../../src/coordination/store.ts";
import { AutomaticDelivery, type BatchMarker } from "../../src/coordination/automation.ts";
import type { Message, Params, Status } from "../../src/coordination/protocol.ts";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function setup(options: { persist?: boolean; start?: boolean; failEvidence?: boolean; startTimeout?: number } = {}) {
    const store = new TeamStore(":memory:"); cleanup.push(() => store.close());
    const a = store.enroll({ room: "r", name: "a", role: "worker", sessionId: "a" });
    const b = store.enroll({ room: "r", name: "b", role: "worker", sessionId: "b" });
    const actor = (c: typeof a) => store.connect({ roomId: c.roomId, participantId: c.participantId, sessionId: c.sessionId, token: c.token }, c.name);
    const aa = actor(a), bb = actor(b); let ready = true, inserted = false, seq = 0;
    const persisted = new Map<string, string>();
    const notify = vi.fn(), changed = vi.fn();
    let hook: ((op: string) => void) | undefined;
    const transport = { async call<T>(op: string, p: Params): Promise<T> { const value = store.dispatch(bb, op, p) as T; hook?.(op); return value; } };
    let automatic: AutomaticDelivery;
    const insert = vi.fn((_content: string, marker: BatchMarker) => {
        inserted = true;
        if (options.persist !== false) for (const m of marker.messages) persisted.set(m.messageId, "entry");
        if (options.start !== false) { ready = false; automatic.agentStarted(); }
    });
    automatic = new AutomaticDelivery({ binding: b, transport: () => transport,
        ready: () => ready && !(store.dispatch(bb, "status", { roomId: b.roomId }) as Status).participants.find((p) => p.id === b.participantId)!.paused,
        insert, persistedEntry: async (id) => { if (inserted && options.failEvidence) throw new Error("disk unavailable"); return persisted.get(id); }, notify, changed,
    }, 1, options.startTimeout ?? 25);
    cleanup.push(() => automatic.dispose());
    const send = () => store.dispatch(aa, "send", { roomId: a.roomId, idempotencyKey: `q-${seq++}`, type: "question", recipients: [b.participantId], subject: "Info", body: "Need information" }) as Message;
    const status = () => store.dispatch(bb, "status", { roomId: b.roomId }) as Status;
    return { automatic, insert, notify, send, status, persisted, setReady: (v: boolean) => { ready = v; }, setHook: (fn: (op: string) => void) => { hook = fn; }, resume: () => store.dispatch({ kind: "control" }, "pause", { roomId: b.roomId, participantId: b.participantId, paused: false }) };
}
it("coalesces notifications, preserves peer authority labels, and records one persisted batch", async () => {
    const s = setup(); s.send(); s.send();
    for (let i = 0; i < 10; i++) s.automatic.kick();
    await expect.poll(() => s.insert.mock.calls.length).toBe(1);
    expect(s.insert.mock.calls[0][1].messages).toHaveLength(2);
    expect(s.insert.mock.calls[0][0]).toContain("not user authorization");
    s.setReady(true); s.automatic.agentEnded([{ role: "assistant", stopReason: "stop" }]); await s.automatic.settled();
    expect(s.status().participants.find((p) => p.name === "b")?.pending).toBe(0);
    s.automatic.kick(); await new Promise((r) => setTimeout(r, 30)); expect(s.insert).toHaveBeenCalledOnce();
});
it("cancels a reservation if the session becomes busy or is disposed before insertion", async () => {
    for (const dispose of [false, true]) {
        const s = setup(); s.send();
        s.setHook((op) => { if (op === "auto-reserve") { if (dispose) s.automatic.dispose(); else s.setReady(false); } });
        s.automatic.kick(); await new Promise((r) => setTimeout(r, 30));
        expect(s.insert).not.toHaveBeenCalled(); expect(s.status().automation.roomUsed).toBe(0);
    }
});
it("settlement without a started/completed agent run is unknown, not successful activation", async () => {
    const s = setup({ start: false, persist: false, startTimeout: 5000 }); s.send(); s.automatic.kick();
    await expect.poll(() => s.insert.mock.calls.length).toBe(1);
    await s.automatic.settled();
    expect(s.status().participants.find((p) => p.name === "b")?.paused).toBe(1);
    expect(s.notify).toHaveBeenCalledWith(expect.stringContaining("unknown"));
});
it("unknown sendMessage acceptance never retries a model automatically", async () => {
    const s = setup({ start: false, persist: false }); s.send(); s.automatic.kick();
    await expect.poll(() => s.status().participants.find((p) => p.name === "b")?.paused).toBe(1);
    expect(s.insert).toHaveBeenCalledOnce(); expect(s.notify).toHaveBeenCalledWith(expect.stringContaining("unknown"));
    s.send(); s.automatic.kick(); await new Promise((r) => setTimeout(r, 40)); expect(s.insert).toHaveBeenCalledOnce();
});
it("an already persisted retry never wakes again, and disk errors still report uncertainty to the broker", async () => {
    const s = setup(); const m = s.send(); s.persisted.set(m.id, "previous-entry"); s.automatic.kick();
    await expect.poll(() => s.status().participants.find((p) => p.name === "b")?.paused).toBe(1);
    expect(s.insert).not.toHaveBeenCalled();
    const failed = setup({ failEvidence: true }); failed.send(); failed.automatic.kick();
    await expect.poll(() => failed.insert.mock.calls.length).toBe(1);
    await failed.automatic.settled();
    expect(failed.status().participants.find((p) => p.name === "b")?.paused).toBe(1);
    expect(failed.notify).toHaveBeenCalledWith(expect.stringContaining("unknown"));
});
