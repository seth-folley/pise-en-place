import { afterEach, expect, it, vi } from "vitest";
import { TeamStore } from "../../src/coordination/store.ts";
import { AutomaticDelivery, type BatchMarker } from "../../src/coordination/automation.ts";
import type { DeliveryTransport } from "../../src/coordination/delivery.ts";
import type { Message, Params, Status } from "../../src/coordination/protocol.ts";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function setup(options: { persist?: boolean; start?: boolean; failEvidence?: boolean; failBeforeInsert?: boolean; startTimeout?: number } = {}) {
    const store = new TeamStore(":memory:"); cleanup.push(() => store.close());
    const a = store.enroll({ room: "r", name: "a", role: "worker", sessionId: "a" });
    const b = store.enroll({ room: "r", name: "b", role: "worker", sessionId: "b" });
    const actor = (c: typeof a) => store.connect({ roomId: c.roomId, participantId: c.participantId, sessionId: c.sessionId, token: c.token }, c.name);
    const aa = actor(a), bb = actor(b); let ready = true, inserted = false, seq = 0, failBeforeInsert = options.failBeforeInsert ?? false;
    const persisted = new Map<string, string>();
    const notify = vi.fn(), changed = vi.fn();
    let hook: ((op: string) => void) | undefined;
    const transport: DeliveryTransport = { async call(op, params) { const value = store.dispatch(bb, op, params as Params); hook?.(op); return value as never; } };
    let automatic: AutomaticDelivery;
    const insert = vi.fn((_content: string, marker: BatchMarker) => {
        inserted = true;
        if (options.persist !== false) for (const m of marker.messages) persisted.set(m.messageId, "entry");
        if (options.start !== false) { ready = false; automatic.agentStarted(); }
    });
    automatic = new AutomaticDelivery({ binding: b, transport: () => transport,
        ready: () => ready && !(store.dispatch(bb, "status", { roomId: b.roomId }) as Status).participants.find((p) => p.id === b.participantId)!.paused,
        insert, persistedEntry: async (id) => { if (failBeforeInsert || (inserted && options.failEvidence)) throw new Error("disk unavailable"); return persisted.get(id); }, notify, changed,
    }, 1, options.startTimeout ?? 25);
    cleanup.push(() => automatic.dispose());
    const send = () => store.dispatch(aa, "send", { roomId: a.roomId, idempotencyKey: `q-${seq++}`, type: "question", recipients: [b.participantId], subject: "Info", body: "Need information" }) as Message;
    const status = () => store.dispatch(bb, "status", { roomId: b.roomId }) as Status;
    return { store, automatic, insert, notify, send, status, persisted, setReady: (v: boolean) => { ready = v; }, setFailBeforeInsert: (v: boolean) => { failBeforeInsert = v; }, setHook: (fn: (op: string) => void) => { hook = fn; }, resume: () => store.dispatch({ kind: "control" }, "pause", { roomId: b.roomId, participantId: b.participantId, paused: false }) };
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
it.each([
    ["length", "error"], ["error", "error"], ["aborted", "aborted"],
    ["toolUse", "unknown"], ["deferred", "unknown"], [undefined, "unknown"],
])("pauses on final stop reason %s instead of completing its activation", async (stopReason, outcome) => {
    const s = setup(); s.send(); s.automatic.kick();
    await expect.poll(() => s.insert.mock.calls.length).toBe(1);
    s.automatic.agentEnded([{ role: "assistant", stopReason }]);
    await s.automatic.settled(false);
    expect(s.store.db.prepare("SELECT state,outcome FROM activations").get()).toMatchObject({ state: "uncertain", outcome });
    expect(s.automatic.isHeld).toBe(true);
    expect(s.status().participants.find(p => p.name === "b")?.paused).toBe(1);
    s.setReady(true); s.send(); s.automatic.kick();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(s.insert).toHaveBeenCalledOnce();
});
it("settlement abort overrides apparent success even before agent_start", async () => {
    for (const start of [false, true]) {
        const s = setup({ start, startTimeout: 5000 }); s.send(); s.automatic.kick();
        await expect.poll(() => s.insert.mock.calls.length).toBe(1);
        if (start) s.automatic.agentEnded([{ role: "assistant", stopReason: "stop" }]);
        await s.automatic.settled(true);
        expect(s.store.db.prepare("SELECT state,outcome FROM activations").get()).toMatchObject({ state: "uncertain", outcome: "aborted" });
    }
});
it("a successful retry supersedes the failed attempt and its abort signal", async () => {
    const s = setup(); s.send(); s.automatic.kick();
    await expect.poll(() => s.insert.mock.calls.length).toBe(1);
    const controller = new AbortController();
    s.automatic.agentStarted(controller.signal);
    s.automatic.agentEnded([{ role: "assistant", stopReason: "error" }]);
    controller.abort();
    s.automatic.agentStarted();
    s.automatic.agentEnded([{ role: "assistant", stopReason: "stop" }]);
    await s.automatic.settled(false);
    expect(s.store.db.prepare("SELECT state,outcome FROM activations").get()).toMatchObject({ state: "settled", outcome: "complete" });
    expect(s.automatic.isHeld).toBe(false);
});
it("missing persisted receipt evidence prevents a successful activation", async () => {
    const s = setup({ persist: false }); s.send(); s.automatic.kick();
    await expect.poll(() => s.insert.mock.calls.length).toBe(1);
    s.automatic.agentEnded([{ role: "assistant", stopReason: "stop" }]);
    await s.automatic.settled(false);
    expect(s.store.db.prepare("SELECT state,outcome FROM activations").get()).toMatchObject({ state: "uncertain", outcome: "unknown" });
    expect(s.automatic.isHeld).toBe(true);
    expect(s.notify).toHaveBeenCalledWith(expect.stringContaining("recording could not be proven"));
    expect(s.notify).not.toHaveBeenCalledWith(expect.stringContaining("completed normally"));
});
it("receipt read failures do not retain a contradictory successful-run description", async () => {
    const s = setup({ failEvidence: true }); s.send(); s.automatic.kick();
    await expect.poll(() => s.insert.mock.calls.length).toBe(1);
    s.automatic.agentEnded([{ role: "assistant", stopReason: "stop" }]);
    await s.automatic.settled(false);
    expect(s.notify).toHaveBeenCalledWith(expect.stringContaining("could not be read"));
    expect(s.notify).not.toHaveBeenCalledWith(expect.stringContaining("completed normally"));
});
it("explicit non-aborted settlement supersedes the low-level attempt's abort signal", async () => {
    const s = setup(); s.send(); s.automatic.kick();
    await expect.poll(() => s.insert.mock.calls.length).toBe(1);
    const controller = new AbortController(); s.automatic.agentStarted(controller.signal);
    controller.abort(); s.automatic.agentEnded([{ role: "assistant", stopReason: "stop" }]);
    await s.automatic.settled(false);
    expect(s.store.db.prepare("SELECT state,outcome FROM activations").get()).toMatchObject({ state: "settled", outcome: "complete" });
});
it("retains the abort-signal fallback when older settlement events omit aborted", async () => {
    const s = setup(); s.send(); s.automatic.kick();
    await expect.poll(() => s.insert.mock.calls.length).toBe(1);
    const controller = new AbortController(); s.automatic.agentStarted(controller.signal);
    s.automatic.agentEnded([{ role: "assistant", stopReason: "stop" }]); controller.abort();
    await s.automatic.settled();
    expect(s.store.db.prepare("SELECT outcome FROM activations").get()?.outcome).toBe("aborted");
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
    expect(s.notify).toHaveBeenCalledWith(expect.stringMatching(/UNCERTAIN · PAUSED.*unknown/));
});
it("unknown sendMessage acceptance never retries a model automatically", async () => {
    const s = setup({ start: false, persist: false }); s.send(); s.automatic.kick();
    await expect.poll(() => s.status().participants.find((p) => p.name === "b")?.paused).toBe(1);
    expect(s.insert).toHaveBeenCalledOnce(); expect(s.notify).toHaveBeenCalledWith(expect.stringMatching(/UNCERTAIN · PAUSED.*unknown/));
    s.send(); s.automatic.kick(); await new Promise((r) => setTimeout(r, 40)); expect(s.insert).toHaveBeenCalledOnce();
});
it("exposes pre-dispatch evidence holds, avoids churn, and retries after explicit resume", async () => {
    const s = setup({ failBeforeInsert: true }); s.send(); s.automatic.kick();
    await expect.poll(() => s.notify.mock.calls.length).toBe(1);
    expect(s.automatic.isHeld).toBe(true);
    expect(s.notify).toHaveBeenCalledWith(expect.stringMatching(/PAUSED \(local\).*Persisted session evidence.*\/team resume local/));
    expect(s.insert).not.toHaveBeenCalled(); expect(s.status().automation.roomUsed).toBe(0);
    for (let i = 0; i < 5; i++) s.automatic.kick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(s.notify).toHaveBeenCalledOnce(); expect(s.insert).not.toHaveBeenCalled();

    s.setFailBeforeInsert(false); s.automatic.resume();
    await expect.poll(() => s.insert.mock.calls.length).toBe(1);
    expect(s.automatic.isHeld).toBe(false);
});
it("reconciles a mixed reserved batch before waking only its unproven delivery", async () => {
    const s = setup();
    const persisted = s.send(), pending = s.send(); s.persisted.set(persisted.id, "previous-entry");
    s.automatic.kick();
    await expect.poll(() => s.insert.mock.calls.length).toBe(1);
    expect(s.insert.mock.calls[0][1].messages.map((m) => m.messageId)).toEqual([pending.id]);
    expect(s.status().participants.find((p) => p.name === "b")?.paused).toBe(0);
});
it("an already persisted retry never wakes again, and disk errors still report uncertainty to the broker", async () => {
    const s = setup(); const m = s.send(); s.persisted.set(m.id, "previous-entry"); s.automatic.kick();
    await new Promise((r) => setTimeout(r, 40));
    expect(s.status().participants.find((p) => p.name === "b")?.paused).toBe(0);
    expect(s.insert).not.toHaveBeenCalled();
    const failed = setup({ failEvidence: true }); failed.send(); failed.automatic.kick();
    await expect.poll(() => failed.insert.mock.calls.length).toBe(1);
    await failed.automatic.settled();
    expect(failed.status().participants.find((p) => p.name === "b")?.paused).toBe(1);
    expect(failed.notify).toHaveBeenCalledWith(expect.stringMatching(/UNCERTAIN · PAUSED.*unknown/));
});
