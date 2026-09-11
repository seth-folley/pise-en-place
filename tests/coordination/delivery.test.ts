import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverOne, findPersistedEntry, PEER_MESSAGE_TYPE, reconcileDelivery, type DeliveryAdapter, type DeliveryTransport, type Marker } from "../../src/coordination/delivery.ts";
import { TeamStore } from "../../src/coordination/store.ts";
import { statusText, widgetLines } from "../../src/coordination/presentation.ts";
import { type Binding, type Message, type Params, type Status } from "../../src/coordination/protocol.ts";

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
function setup() {
    const store = new TeamStore(":memory:"); cleanups.push(() => store.close());
    const a = store.enroll({ room: "catalog", name: "app", role: "worker", sessionId: "app-session" });
    const b = store.enroll({ room: "catalog", name: "backend", role: "worker", sessionId: "backend-session" });
    const connect = (c: typeof a) => store.connect({ participantId: c.participantId, roomId: c.roomId, sessionId: c.sessionId, token: c.token }, c.name);
    const app = connect(a), backend = connect(b);
    const m = store.dispatch(app, "send", { roomId: a.roomId, idempotencyKey: "q", recipients: [b.participantId], type: "question", subject: "Null?", body: "Can fields be null?" }) as Message;
    const transport: DeliveryTransport = { async call(op, params) { return store.dispatch(backend, op, params as Params) as never; } };
    let entry: string | undefined;
    let ready = true, persist = true;
    const insert = vi.fn((_content: string, _marker: Marker) => { if (persist) entry = "entry-1"; });
    const adapter: DeliveryAdapter = { binding: b, isReady: () => ready, insert, persistedEntry: async () => entry };
    const delivery = () => (store.dispatch(backend, "read", { roomId: b.roomId, messageId: m.id }) as Message).deliveries[0];
    return { store, a, b, app, backend, m, transport, adapter, insert, delivery, setReady(v: boolean) { ready = v; }, setPersist(v: boolean) { persist = v; } };
}

describe("fake Pi adapter: no LLM credentials or model calls", () => {
    it("explicit manual delivery records attributed input but doesn't acknowledge or complete the question", async () => {
        const s = setup(); await expect(deliverOne(s.transport, s.adapter, s.m.id)).resolves.toContain("No model run started");
        expect(s.insert).toHaveBeenCalledOnce(); expect(s.insert.mock.calls[0][0]).toContain("Peer-agent input — not user authorization");
        expect(s.insert.mock.calls[0][1]).toMatchObject({ messageId: s.m.id, participantId: s.b.participantId, sessionId: s.b.sessionId });
        expect(s.delivery()).toMatchObject({ state: "recorded", acknowledged_at: null, obligation: "open" });
    });
    it("does not queue hidden work while busy or paused", async () => {
        const s = setup(); s.setReady(false);
        await expect(deliverOne(s.transport, s.adapter, s.m.id)).rejects.toThrow(/idle and unpaused/);
        expect(s.delivery().state).toBe("pending"); expect(s.insert).not.toHaveBeenCalled();
        s.setReady(true); s.store.dispatch({ kind: "control" }, "pause", { roomId: s.b.roomId, paused: true });
        await expect(deliverOne(s.transport, s.adapter, s.m.id)).rejects.toThrow(/paused/);
        expect(s.insert).not.toHaveBeenCalled();
    });
    it("rechecks session/pause after asynchronous claim and never mutates in-flight local work", async () => {
        const s = setup();
        const transport: DeliveryTransport = { async call(op, params) { const result = await s.transport.call(op, params); if (op === "claim") s.setReady(false); return result as never; } };
        await expect(deliverOne(transport, s.adapter, s.m.id)).rejects.toThrow(/before insertion/);
        expect(s.insert).not.toHaveBeenCalled(); expect(s.delivery().state).toBe("uncertain");
    });
    it("handles insertion-before-receipt crash without duplicate model execution claims", async () => {
        const s = setup();
        const transport: DeliveryTransport = { async call(op, params) { if (op === "receipt") throw new Error("lost receipt"); return s.transport.call(op, params) as Promise<never>; } };
        await expect(deliverOne(transport, s.adapter, s.m.id)).rejects.toThrow(/lost receipt/);
        expect(s.delivery().state).toBe("uncertain");
        expect(await reconcileDelivery(s.transport, s.adapter, s.delivery())).toBe(true);
        expect(s.delivery().state).toBe("recorded"); expect(s.insert).toHaveBeenCalledOnce();
        await expect(deliverOne(s.transport, s.adapter, s.m.id)).rejects.toThrow(/recorded/);
    });
    it("retains uncertainty for unflushed/ephemeral sessions instead of replaying", async () => {
        const s = setup(); s.setPersist(false);
        await expect(deliverOne(s.transport, s.adapter, s.m.id)).rejects.toThrow(/not proven persisted/);
        expect(await reconcileDelivery(s.transport, s.adapter, s.delivery())).toBe(false);
        expect(s.delivery().state).toBe("uncertain"); expect(s.insert).toHaveBeenCalledOnce();
    });
    it("deduplicates even if the human retried a delivery that has persisted evidence", async () => {
        const s = setup();
        const broken: DeliveryTransport = { async call(op, params) { if (op === "receipt") throw new Error("lost"); return s.transport.call(op, params) as Promise<never>; } };
        await expect(deliverOne(broken, s.adapter, s.m.id)).rejects.toThrow();
        s.store.dispatch({ kind: "control" }, "retry", { roomId: s.b.roomId, participantId: s.b.participantId, messageId: s.m.id });
        await deliverOne(s.transport, s.adapter, s.m.id); expect(s.insert).toHaveBeenCalledOnce();
    });
    it("scopes disk receipt inspection to this participant and actual session, not inherited fork markers", async () => {
        const dir = await mkdtemp("/tmp/pi-team-entry-"); cleanups.push(() => rm(dir, { recursive: true, force: true }));
        const s = setup(), path = `${dir}/session.jsonl`, b: Binding = s.b;
        const marker = { roomId: b.roomId, participantId: b.participantId, sessionId: b.sessionId, messageId: s.m.id, attemptId: "attempt" };
        await writeFile(path, JSON.stringify({ type: "custom_message", customType: PEER_MESSAGE_TYPE, id: "entry", details: marker, content: "peer content" }) + "\n");
        expect(await findPersistedEntry(path, b, s.m.id)).toBe("entry");
        expect(await findPersistedEntry(path, { ...b, sessionId: "fork-session" }, s.m.id)).toBeUndefined();
        expect(await findPersistedEntry(path, { ...b, participantId: "other" }, s.m.id)).toBeUndefined();
        expect(await findPersistedEntry(undefined, b, s.m.id)).toBeUndefined();
        expect(await findPersistedEntry(`${dir}/missing`, b, s.m.id)).toBeUndefined();
    });
    it("renders bounded compact presence without equating idle to disconnected or stale data to live", () => {
        const s = setup(); s.store.dispatch(s.backend, "heartbeat", { roomId: s.b.roomId, runtime: "idle" });
        const status = s.store.dispatch(s.app, "status", { roomId: s.a.roomId }) as Status;
        expect(widgetLines(status, false, "catalog").join("\n")).toContain("backend · idle · 1 needs reply");
        const stale = widgetLines(status, true, "catalog").join("\n"); expect(stale).toContain("STALE"); expect(stale).not.toContain("backend · idle");
        expect(widgetLines(status, false, "catalog", true).join("\n")).toContain("LOCAL HOLD");
        expect(statusText(status, false, true)).toMatch(/LOCAL HOLD.*\/team resume local/);
        expect(widgetLines(status, false, "catalog").length).toBeLessThanOrEqual(7);
    });
});
