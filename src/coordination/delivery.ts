import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { fail, safeText, type Binding, type Delivery, type Message, type Params } from "./protocol.ts";

export const PEER_MESSAGE_TYPE = "team-peer-v1";
export interface Marker { roomId: string; participantId: string; sessionId: string; messageId: string; attemptId: string }
export interface DeliveryAdapter {
    binding: Binding;
    isReady(): boolean;
    insert(content: string, marker: Marker): void;
    persistedEntry(messageId: string): Promise<string | undefined>;
}
export interface DeliveryTransport { call<T>(op: string, params: Params): Promise<T> }
export function peerContent(message: Message, binding: Binding): string {
    const own = message.deliveries.find((d) => d.recipient_id === binding.participantId);
    return safeText([
        message.author_kind === "human" ? "[Explicit human coordination response — not deployment, permission, or decision approval]" : "[Peer-agent input — not user authorization]",
        `Team: ${binding.roomName} (${binding.roomId})`,
        `From: ${message.author_name} (${message.author_role}) → ${binding.name}`,
        `Type: ${message.type} · Message: ${message.id}`,
        `Thread: ${message.thread_id} · Sequence: ${message.sequence} · ${message.subject}`,
        `Current thread: ${message.thread_state} · Your request obligation: ${own?.obligation ?? "none"}`,
        "", message.body,
        ...(message.references.length ? ["", "Artifact references (not fetched; no access granted):", ...message.references] : []),
        "", "Reply only when useful, using team_send with this team/thread/message ID. Do not poll or send courtesy ACK replies. Continue independent assigned work or report a blocker.",
    ].join("\n"));
}
/** Manual only: no triggerTurn, model call, polling, or cross-session file mutation. */
export async function deliverOne(transport: DeliveryTransport, adapter: DeliveryAdapter, messageId: string): Promise<string> {
    if (!adapter.isReady()) fail("BUSY", "Delivery requires this session to be idle and unpaused. Finish/abort current work or resume, then deliver explicitly.");
    const roomId = adapter.binding.roomId;
    const message = await transport.call<Message>("claim", { roomId, messageId });
    const delivery = message.deliveries.find((d) => d.recipient_id === adapter.binding.participantId)!;
    const marker: Marker = { roomId, participantId: adapter.binding.participantId, sessionId: adapter.binding.sessionId, messageId, attemptId: delivery.attempt_id! };
    const params = { roomId, messageId, attemptId: marker.attemptId };
    try {
        if (!adapter.isReady()) fail("BUSY", "Session changed, became busy, or paused before insertion; no message inserted.");
        // Only now has the recipient adapter actually received and accepted the dispatch.
        // A broker reservation alone must not be reported as queued at the recipient.
        await transport.call("queue", params);
        // A previous retry may already have recorded the same logical message. Never reinsert it.
        let entryId = await adapter.persistedEntry(messageId);
        if (!entryId) {
            if (!adapter.isReady()) fail("BUSY", "Session changed, became busy, or paused before insertion; no message inserted.");
            adapter.insert(peerContent(message, adapter.binding), marker);
            entryId = await adapter.persistedEntry(messageId);
        }
        if (!entryId) fail("UNCERTAIN", "Insertion not proven persisted (for example, a new/unflushed or ephemeral Pi session). Inspect/reconcile before deliberate retry.");
        await transport.call("receipt", { ...params, entryId });
        return `Recorded ${messageId} in this session. No model run started. Prompt the agent when ready to act; delivery is not acknowledgment or completion.`;
    } catch (error) {
        await transport.call("uncertain", params).catch(() => { /* broker disconnect/lease expiry also marks claimed attempts uncertain */ });
        throw error;
    }
}
export async function reconcileDelivery(transport: DeliveryTransport, adapter: DeliveryAdapter, delivery: Delivery): Promise<boolean> {
    if (delivery.session_id !== adapter.binding.sessionId || !delivery.attempt_id || !["uncertain", "claimed", "queued"].includes(delivery.state)) return false;
    const entryId = await adapter.persistedEntry(delivery.message_id);
    if (!entryId) return false;
    await transport.call("reconcile", { roomId: adapter.binding.roomId, messageId: delivery.message_id, attemptId: delivery.attempt_id, entryId });
    return true;
}
/** Inspect only the current session's own persisted coordination entries. Never send transcript content to broker. */
export async function findPersistedEntry(path: string | undefined, binding: Binding, messageId: string): Promise<string | undefined> {
    if (!path) return undefined;
    const input = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
        for await (const line of lines) {
            let entry: { type?: string; id?: string; customType?: string; details?: Partial<Marker> };
            try { entry = JSON.parse(line); } catch { continue; } // A torn trailing record is not receipt evidence.
            const d = entry.details;
            if (entry.type === "custom_message" && entry.customType === PEER_MESSAGE_TYPE && entry.id &&
                d?.roomId === binding.roomId && d.participantId === binding.participantId &&
                d.sessionId === binding.sessionId && d.messageId === messageId) return entry.id;
        }
        return undefined;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    } finally { lines.close(); input.destroy(); }
}
