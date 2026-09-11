import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { safeText } from "../../src/coordination/protocol.ts";
import type { NavigationMessage, TeamNavigationSnapshot } from "../../src/coordination/navigation.ts";

const COMMANDS = ["dashboard", "status", "inbox", "thread", "read", "deliver", "reconcile", "retry", "review", "resolve", "pause", "resume", "leave", "help"];
const UNENROLLED = ["join", "help"];

function label(value: string): string {
    const clean = safeText(value).replace(/\s+/g, " ").trim();
    if (Buffer.byteLength(clean) <= 90) return clean;
    let result = "";
    for (const character of clean) {
        if (Buffer.byteLength(result + character) > 87) break;
        result += character;
    }
    return result + "…";
}
function filter(prefix: string, items: AutocompleteItem[]): AutocompleteItem[] | null {
    const matches = items.filter((item) => item.value.startsWith(prefix));
    return matches.length ? matches : null;
}
function messageItem(command: string, message: NavigationMessage): AutocompleteItem {
    return { value: `${command} ${message.id}`, label: label(`${message.subject || "Untitled"} · ${message.authorName}`), description: message.id };
}

/** Pure, bounded-cache-only completion for the entire `/team` argument tail. */
export function teamArgumentCompletions(prefix: string, snapshot: TeamNavigationSnapshot): AutocompleteItem[] | null {
    const value = prefix.trimStart();
    if (!snapshot.room) return filter(value, UNENROLLED.map((command) => ({ value: command, label: command })));
    const [command, ...args] = value.split(/\s+/);
    if (!value || !args.length && !value.endsWith(" ")) return filter(value, COMMANDS.map((item) => ({ value: item, label: item })));
    const messages = [...new Map(snapshot.messages.map((message) => [message.id, message])).values()];
    const threads = [...new Set(messages.map((message) => message.threadId))];
    if (["read", "deliver", "reconcile", "retry", "review"].includes(command)) {
        return filter(value, messages.map((message) => messageItem(command, message)));
    }
    if (["thread", "resolve"].includes(command)) {
        return filter(value, threads.map((threadId) => ({ value: `${command} ${threadId}`, label: label(`Thread ${threadId}`) })));
    }
    if (command === "inbox") return filter(value, [{ value: "inbox --history", label: "Include history" }]);
    if (command === "pause" || command === "resume") {
        return filter(value, ["local", "room"].map((scope) => ({ value: `${command} ${scope}`, label: `${command} ${scope}` })));
    }
    if (command === "status") {
        if (args.length <= 1) {
            return filter(value, [snapshot.room.name, snapshot.room.id].filter(Boolean).map((room) => ({ value: `status ${room}`, label: label(`Current room · ${room}`) })));
        }
        const room = args[0];
        if (room !== snapshot.room.id && room !== snapshot.room.name) return null;
        return filter(value, snapshot.participants.map((participant) => ({ value: `status ${room} ${participant.id}`, label: label(`${participant.name} · ${participant.role}`), description: participant.id })));
    }
    return null;
}
