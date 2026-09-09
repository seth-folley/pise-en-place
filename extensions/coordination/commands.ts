import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { messageText, pageText, statusText } from "../../src/coordination/presentation.ts";
import { TeamError, type Message, type Page, type Params, type Status } from "../../src/coordination/protocol.ts";
import { TEAM_HELP as HELP } from "./constants.ts";
import { CoordinationRuntime, errorText } from "./runtime.ts";

export function registerTeamCommand(pi: ExtensionAPI, runtime: CoordinationRuntime): void {
    pi.registerCommand("team", {
        description: "Join an isolated team room with automatic peer communication; inspect, pause, or review messages",
        handler: async (args, commandCtx) => {
            const [op = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
            try {
                if (op === "help") { runtime.inspect(HELP); return; }
                if (op === "join") {
                    if (runtime.binding) throw new Error("Already enrolled. This pilot supports one room per session; /team leave first or join the other room in another Pi session.");
                    const room = rest[0];
                    let name: string | undefined, role = "worker", rejoin = false;
                    for (let i = 1; i < rest.length; i++) {
                        if (rest[i] === "--name") name = rest[++i];
                        else if (rest[i] === "--role") role = rest[++i]!;
                        else if (rest[i] === "--rejoin") rejoin = true;
                        else throw new Error("Unknown join option. " + HELP.split("\n")[1]);
                    }
                    if (!room || !name || !role) throw new Error(HELP.split("\n")[1]);
                    if (!await runtime.confirm(commandCtx, `${rejoin ? "Rejoin" : "Join"} team ${room} as ${name}?`, "Share only explicit messages/status with this room. Delivered content goes to peers' model providers. Eligible messages automatically wake this session when idle (no thread cap, 100 activations/room/hour); model usage may incur costs. Busy work is not interrupted; abort pauses local automation. Rejoin recovers this name's existing mailbox and can rebind a disconnected prior session; no live takeover.")) return;
                    if (!await runtime.join(commandCtx, room, name, role, rejoin)) return;
                    const binding = runtime.binding!;
                    runtime.inspect(`Joined ${room} as ${binding.name}. Room ID ${binding.roomId}\n${runtime.client ? "Connected. Eligible inbox messages will be processed automatically at idle boundaries." : runtime.lastError}\n/team status · /team inbox · /team help`);
                    return;
                }
                const binding = runtime.binding;
                if (!runtime.client && binding && op === "status") {
                    if (rest.length && rest[0] !== binding.roomName && rest[0] !== binding.roomId) throw new Error("This session is not enrolled in that room.");
                    runtime.inspect(runtime.status ? `${statusText(runtime.status, true)}\n${runtime.lastError}` : `TEAM ${binding.roomName} · broker unavailable · presence unknown\n${runtime.lastError}\nAutomatic reconnect is pending; local coding can continue.`);
                    return;
                }
                if (!runtime.client && binding && op === "leave") {
                    if (!await runtime.confirm(commandCtx, `Detach from ${binding.roomName} while offline?`, "Stop reconnecting this session. The broker cannot record an explicit departure while unavailable; its membership/history remain for explicit rejoin.")) return;
                    runtime.detachOffline();
                    return;
                }
                const connection = runtime.requireClient();
                const scope = { roomId: connection.binding.roomId };
                if (op === "status") {
                    if (rest.length && rest[0] !== connection.binding.roomName && rest[0] !== connection.binding.roomId) throw new Error("This session is not enrolled in that room.");
                    if (rest.length > 2) throw new Error("Usage: /team status [joined-room] [participant-id]");
                    runtime.inspect(statusText(await connection.client.call("status", { ...scope, ...(rest[1] ? { participantId: rest[1] } : {}) })));
                    return;
                }
                if (op === "inbox" || op === "thread" || op === "read") {
                    if ((op === "thread" || op === "read") && !rest[0]) throw new Error(`Usage: /team ${op} <id>`);
                    const inboxArgs = rest.filter((arg) => arg !== "--history");
                    const cursor = Number((op === "inbox" ? inboxArgs[0] : rest[1]) ?? 0);
                    const query = op === "read" ? { ...scope, messageId: rest[0] } : op === "thread" ? { ...scope, threadId: rest[0], cursor } : { ...scope, cursor, history: rest.includes("--history") };
                    const value = await connection.client.call("read", query);
                    runtime.inspect("items" in value ? pageText(value) : messageText(value));
                    return;
                }
                if (["deliver", "reconcile", "retry"].includes(op)) {
                    const id = rest[0];
                    if (!id) throw new Error(`Usage: /team ${op} <message>`);
                    await runtime.withDelivery(async () => {
                        if (op === "deliver") runtime.inspect(await runtime.deliver(connection.client, commandCtx, connection.binding, id));
                        else {
                            const message = await connection.client.call("read", { ...scope, messageId: id });
                            const delivery = message.deliveries.find((item) => item.recipient_id === connection.binding.participantId);
                            if (!delivery) throw new Error("This message is not addressed to you.");
                            if (await runtime.reconcile(connection.client, commandCtx, connection.binding, delivery)) runtime.inspect("Persisted entry reconciled. No duplicate insertion or model run.");
                            else if (op === "retry" && await runtime.confirm(commandCtx, "Retry uncertain delivery?", "No matching persisted entry was found for this session. Prior execution cannot be ruled out. Retry may duplicate work. If unpaused and within budget, an eligible message can run automatically.")) {
                                await runtime.control("retry", { ...scope, participantId: connection.binding.participantId, messageId: id });
                                runtime.inspect("Delivery reset to pending by explicit human action. Eligible messages can now run automatically if unpaused and within budget.");
                            } else runtime.inspect("No matching persisted receipt found. Outcome remains uncertain; no message replayed.");
                        }
                    });
                    await runtime.refresh();
                    return;
                }
                if (op === "pause" || op === "resume") {
                    const scopeName = rest[0] ?? "local";
                    if (!["local", "room", "project"].includes(scopeName)) throw new Error("Use local or room pause scope.");
                    if (!await runtime.confirm(commandCtx, `${op} ${scopeName} delivery?`, `Team ${connection.binding.roomName}. Does not abort current work or undo dispatched operations. Resume can wake still-eligible pending messages; it does not replay recorded history or reset budgets.`)) return;
                    if (scopeName === "local") runtime.setLocalPaused(op === "pause");
                    await runtime.control("pause", { ...scope, ...(scopeName === "local" ? { participantId: connection.binding.participantId } : {}), paused: op === "pause" });
                    if (op === "resume" && scopeName === "local") runtime.resumeAutomatic();
                    await runtime.refresh();
                    return;
                }
                if (op === "leave") {
                    if (!await runtime.confirm(commandCtx, `Leave ${connection.binding.roomName}?`, "Stop delivery to this session. Keep all history and pending messages for explicit rejoin.")) return;
                    await runtime.leave(connection.client, connection.binding);
                    return;
                }
                if (op === "resolve") {
                    if (!rest[0]) throw new Error("Usage: /team resolve <thread>");
                    if (!await runtime.confirm(commandCtx, "Resolve this discussion?", `Team ${connection.binding.roomName} · Thread ${rest[0]}. Closes open response obligations, not a protected decision approval.`)) return;
                    await runtime.control("resolve", { ...scope, threadId: rest[0] });
                    await runtime.refresh();
                    return;
                }
                if (op === "review") {
                    if (!rest[0]) throw new Error("Usage: /team review <message>");
                    if (commandCtx.mode !== "tui") throw new Error("Review currently requires TUI. Request remains pending.");
                    const message = await connection.client.call("read", { ...scope, messageId: rest[0] });
                    runtime.inspect(messageText(message));
                    const selected = await commandCtx.ui.select("Review recipient delivery", message.deliveries.map((delivery) => `${delivery.recipientName} · ${delivery.state} · ${delivery.obligation} · ${delivery.recipient_id}`));
                    const delivery = message.deliveries.find((item) => selected?.endsWith(item.recipient_id));
                    if (!delivery) return;
                    const action = await commandCtx.ui.select("Human review (no protected approval)", ["Keep waiting", "Answer as human", "Redirect within room", "Cancel request"]);
                    if (!action || action === "Keep waiting") return;
                    let body: string | undefined, idempotencyKey: string | undefined, recipientId: string | undefined;
                    if (action === "Answer as human") {
                        body = await commandCtx.ui.editor("Human coordination answer (not decision approval)", "");
                        if (!body?.trim()) return;
                        idempotencyKey = randomUUID();
                    } else if (action === "Redirect within room") {
                        const status = await connection.client.call("status", scope);
                        const choices = status.participants.filter((participant) => participant.joined && !message.deliveries.some((item) => item.recipient_id === participant.id));
                        const choice = await commandCtx.ui.select("Choose room participant", choices.map((participant) => `${participant.name} · ${participant.presence} · ${participant.id}`));
                        recipientId = choices.find((participant) => choice?.endsWith(participant.id))?.id;
                        if (!recipientId) return;
                    }
                    if (!await runtime.confirm(commandCtx, `${action}?`, `Team ${connection.binding.roomName} · Message ${message.id} · recipient ${delivery.recipientName}. Changes are durable and cannot retract content already delivered.`)) return;
                    const target = { ...scope, messageId: message.id, participantId: delivery.recipient_id };
                    if (action === "Answer as human") await runtime.control("answer", { ...target, body: body!, idempotencyKey: idempotencyKey! });
                    else if (action === "Redirect within room") await runtime.control("redirect", { ...target, recipientId: recipientId! });
                    else await runtime.control("cancel", target);
                    runtime.inspect(`Human action recorded: ${action}. Eligible recipients may process this update automatically at idle boundaries.`);
                    await runtime.refresh();
                    return;
                }
                throw new Error(HELP);
            } catch (error) {
                commandCtx.ui.notify(`Team: ${errorText(error)}`, "error");
                if (error instanceof TeamError && error.code === "NAME_EXISTS") runtime.inspect("To recover an existing disconnected/left participant, explicitly use /team join <room> --name <name> --role <role> --rejoin. Another session's live identity cannot be taken over.");
            }
        },
    });
}
