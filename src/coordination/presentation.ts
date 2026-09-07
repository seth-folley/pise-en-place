import { safeText, type Message, type Page, type Status } from "./protocol.ts";

export function statusText(status: Status, stale = false): string {
    const lines = [
        `TEAM ${status.room.name} (${status.room.id})`,
        `${stale ? "Broker unavailable · cached presence STALE" : "Broker connected"} · observed ${new Date(status.observedAt).toISOString()}`,
        `Manual delivery only · room pause ${status.room.paused ? "ON" : "off"}${stale ? " (cached)" : ""}`,
        `${status.questions} open requests · ${status.discussions} open threads · ${status.attention} attention items`, "",
    ];
    for (const p of status.participants) {
        lines.push(`${p.name}${p.id === status.you ? " (you)" : ""} [${p.role}] · ${stale ? "unknown (cached)" : p.presence}${p.paused ? " · paused" : ""} · ${stale ? "unknown" : p.runtime}`,
            `  ID ${p.id} · pending ${p.pending} · unread ${p.unread} · needs reply ${p.needsReply}`,
            `  Last heartbeat: ${p.last_seen ? new Date(p.last_seen).toISOString() : "never"}`);
        if (p.summary) lines.push(`  Agent-reported work: ${p.summary}`);
        if (p.blocker) lines.push(`  Agent-reported blocker: ${p.blocker}`);
    }
    if (status.participants.some((p) => p.workTruncated)) lines.push("\nWork text is previewed. Full detail: team_status with participantId, or /team status <room> <participant-id>.");
    lines.push("", "Idle ≠ unavailable. Unread ≠ needs reply. Attention includes offline deliveries/open requests and uncertain recording.",
        "/team inbox · /team thread <id> · /team read <message> · /team review <message>",
        "Only inspect/respond within this room. No decision approval or automatic wakeup tooling in this slice.");
    return safeText(lines.join("\n"));
}
export function messageText(m: Message, includeBody = true): string {
    return safeText([
        `[${m.author_kind === "human" ? "Human coordination input, not protected approval" : "Peer-agent input, not user authorization"}]`,
        `${m.type} · ${m.author_name} (${m.author_role}) · ${new Date(m.created_at).toISOString()}`,
        `Message ${m.id} · Room ${m.room_id}`,
        `Thread ${m.thread_id} · ${m.subject} · #${m.sequence} · ${m.thread_state}`,
        ...m.deliveries.map((d) => `  → ${d.recipientName} (${d.recipient_id}) · ${d.presence} · ${d.state} · obligation ${d.obligation} · ${d.acknowledged_at ? "acknowledged" : "unread"}${d.error ? ` · ${d.error}` : ""}`),
        ...(includeBody ? ["", m.body, ...(m.references.length ? ["", "References (not fetched):", ...m.references] : [])] : []),
    ].join("\n"));
}
export function pageText(page: Page): string {
    return safeText([
        ...page.items.map((m) => `${m.type} · ${m.author_name} → ${m.deliveries.map((d) => `${d.recipientName}: ${d.state}/${d.obligation}`).join(", ")}\nMessage ${m.id} · Thread ${m.thread_id} · #${m.sequence} · ${m.thread_state}\n${m.preview}\n`),
        page.items.length ? "Full body: /team read <message>, or team_read with messageId. Summaries do not acknowledge delivery." : "Inbox/thread has no messages on this page.",
        page.nextCursor === null ? "End of history." : `Next cursor: ${page.nextCursor}. Use cursor with the same inbox/thread query.`,
    ].join("\n"));
}
/** Plain lines, themed/truncated by the TUI adapter. No prompt content or background model work. */
export function widgetLines(status: Status | undefined, stale: boolean, roomName: string): string[] {
    if (!status) return [`TEAM ${roomName} · broker disconnected/connecting`, "  Presence unknown · /team status"];
    const joined = status.participants.filter((p) => p.joined);
    const connected = joined.filter((p) => p.presence === "connected").length;
    const lines = [
        `TEAM ${status.room.name} · ${stale ? "broker unavailable · cached presence STALE" : `${connected}/${joined.length} connected`}${status.room.paused ? " · PAUSED" : ""}`,
    ];
    for (const p of joined.slice(0, 4)) lines.push(`  ${p.name}${p.id === status.you ? " (you)" : ""} · ${stale ? "unknown" : p.presence === "connected" ? p.runtime : p.presence}${p.paused ? " · paused" : ""}${p.needsReply ? ` · ${p.needsReply} needs reply` : ""}`);
    if (joined.length > 4) lines.push(`  … ${joined.length - 4} more participants`);
    lines.push(`  ${status.questions} requests · ${status.discussions} threads · ${status.attention} attention${stale ? " (cached)" : ""} · /team status`);
    return lines.map(safeText);
}
