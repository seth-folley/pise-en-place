import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { PEER_BATCH_TYPE } from "../../src/coordination/automation.ts";
import { PEER_MESSAGE_TYPE } from "../../src/coordination/delivery.ts";
import { widgetLines } from "../../src/coordination/presentation.ts";
import { safeText, type Binding, type Status } from "../../src/coordination/protocol.ts";
import { INSPECT_ENTRY_TYPE, WIDGET_ID } from "./constants.ts";

export function renderWidget(context: ExtensionContext | undefined, binding: Binding | undefined, status: Status | undefined, connected: boolean): void {
    if (!context?.hasUI) return;
    if (!binding) { context.ui.setWidget(WIDGET_ID, undefined); return; }
    if (context.mode !== "tui") {
        context.ui.setWidget(WIDGET_ID, widgetLines(status, !connected, binding.roomName)); return;
    }
    context.ui.setWidget(WIDGET_ID, (_tui, theme) => ({
        invalidate() {},
        render(width) {
            const lines = widgetLines(status, !connected, binding.roomName);
            if (width < 4) return lines.map((line) => truncateToWidth(line, Math.max(0, width)));
            const innerWidth = width - 4;
            const title = truncateToWidth(` ${lines[0]} `, width - 3);
            const top = `╭─${theme.fg("accent", theme.bold(title))}${theme.fg("muted", "─".repeat(width - 3 - visibleWidth(title)))}╮`;
            const rows = lines.slice(1).map((line) => {
                const color = /disconnected|STALE|PAUSED|unknown/.test(line) ? "warning" : "muted";
                const text = truncateToWidth(theme.fg(color, line.replace(/^  /, "")), innerWidth);
                return `│ ${text}${" ".repeat(Math.max(0, innerWidth - visibleWidth(text)))} │`;
            });
            return [top, ...rows, `╰${"─".repeat(width - 2)}╯`];
        },
    }));
}

export function registerCoordinationRenderers(pi: ExtensionAPI): void {
    pi.registerEntryRenderer(INSPECT_ENTRY_TYPE, (entry, _options, _theme) => {
        const data = entry.data as { text?: string } | undefined;
        return new Text(safeText(data?.text ?? "Team inspection unavailable"), 0, 0);
    });
    pi.registerMessageRenderer(PEER_MESSAGE_TYPE, (message, _options, theme) => new Text(theme.fg("customMessageText", safeText(typeof message.content === "string" ? message.content : "Team peer message")), 0, 0));
    pi.registerMessageRenderer(PEER_BATCH_TYPE, (message, _options, theme) => new Text(theme.fg("customMessageText", safeText(typeof message.content === "string" ? message.content : "Automatic team inbox")), 0, 0));
}
