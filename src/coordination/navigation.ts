import { safeText, type DeliveryState, type Message, type MessageSummary, type Obligation, type Page, type ParticipantStatus, type Status } from "./protocol.ts";

export interface NavigationParticipant {
    id: string;
    name: string;
    role: string;
    presence: ParticipantStatus["presence"];
    joined: boolean;
    paused: boolean;
}
export interface NavigationMessage {
    id: string;
    threadId: string;
    type: Message["type"];
    subject: string;
    authorName: string;
    sequence: number;
    createdAt: number;
    threadState: Message["thread_state"];
    ownDeliveryState?: DeliveryState;
    ownObligation?: Obligation;
}
export interface TeamNavigationSnapshot {
    room?: { id: string; name: string };
    participants: readonly NavigationParticipant[];
    messages: readonly NavigationMessage[];
}

const MAX_MESSAGES = 100;
const MAX_PARTICIPANTS = 128;
const MAX_COLLECTION_BYTES = 64 * 1024;

/** Session-only, bounded navigation metadata. It is never authorization evidence. */
export class TeamNavigationCache {
    private room?: { id: string; name: string };
    private participants = new Map<string, NavigationParticipant>();
    private messages = new Map<string, NavigationMessage>();

    reset(roomId?: string): void {
        this.participants.clear();
        this.messages.clear();
        this.room = roomId ? { id: roomId, name: this.room?.id === roomId ? this.room.name : "" } : undefined;
    }
    private adoptRoom(id: string, name: string): boolean {
        if (this.room && this.room.id !== id) return false;
        this.room = { id, name: safeText(name || this.room?.name || "") };
        return true;
    }
    rememberStatus(status: Status, selfParticipantId: string): void {
        if (!this.adoptRoom(status.room.id, status.room.name)) return;
        for (const participant of status.participants) {
            this.participants.delete(participant.id);
            this.participants.set(participant.id, {
            id: participant.id,
            name: safeText(participant.name),
            role: safeText(participant.role),
            presence: participant.presence,
            joined: participant.joined !== 0,
                paused: participant.paused !== 0,
            });
        }
        this.trimParticipants();
    }
    rememberMessage(message: Message | MessageSummary, selfParticipantId: string): void {
        if (!this.adoptRoom(message.room_id, this.room?.name ?? "")) return;
        const own = message.deliveries.find((delivery) => delivery.recipient_id === selfParticipantId);
        this.messages.delete(message.id);
        this.messages.set(message.id, {
            id: message.id,
            threadId: message.thread_id,
            type: message.type,
            subject: safeText(message.subject),
            authorName: safeText(message.author_name),
            sequence: message.sequence,
            createdAt: message.created_at,
            threadState: message.thread_state,
            ...(own ? { ownDeliveryState: own.state, ownObligation: own.obligation } : {}),
        });
        this.trimMessages();
    }
    rememberPage(page: Page, selfParticipantId: string): void {
        for (const message of page.items) this.rememberMessage(message, selfParticipantId);
    }
    snapshot(): TeamNavigationSnapshot {
        return {
            ...(this.room ? { room: { ...this.room } } : {}),
            participants: this.sortedParticipants().map((participant) => ({ ...participant })),
            messages: this.sortedMessages().map((message) => ({ ...message })),
        };
    }
    private sortedMessages(): NavigationMessage[] {
        return [...this.messages.values()].sort((a, b) => b.createdAt - a.createdAt || b.sequence - a.sequence || a.id.localeCompare(b.id));
    }
    private sortedParticipants(): NavigationParticipant[] {
        return [...this.participants.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    }
    private trimMessages(): void {
        let values = this.sortedMessages();
        while (values.length > MAX_MESSAGES || Buffer.byteLength(JSON.stringify(values)) > MAX_COLLECTION_BYTES) {
            const oldest = values.pop();
            if (!oldest) return;
            this.messages.delete(oldest.id);
            values = this.sortedMessages();
        }
    }
    private trimParticipants(): void {
        while (this.participants.size > MAX_PARTICIPANTS || Buffer.byteLength(JSON.stringify([...this.participants.values()])) > MAX_COLLECTION_BYTES) {
            const oldest = this.participants.keys().next().value as string | undefined;
            if (!oldest) return;
            this.participants.delete(oldest);
        }
    }
}
