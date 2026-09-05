import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Theme = {
    fg(color: string, text: string): string;
    bold(text: string): string;
};

export type SubagentWidgetItem = {
    agent: string;
    activity?: string;
    exitCode: number;
    stopReason?: string;
};

function fit(value: string, width: number): string {
    const truncated = truncateToWidth(value, Math.max(0, width));
    return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

/** A compact, width-aware activity tray shown immediately above Pi's editor. */
export function createSubagentWidget(items: SubagentWidgetItem[]) {
    return (_tui: unknown, theme: Theme) => ({
        invalidate() {},
        render(width: number): string[] {
            const innerWidth = Math.max(1, width - 4);
            const running = items.filter((item) => item.exitCode === -1).length;
            const complete = items.length - running;
            const title = running
                ? ` Subagents · ${complete}/${items.length} complete · ${running} running `
                : ` Subagents · ${items.length}/${items.length} complete `;
            const titleText = theme.fg("accent", theme.bold(title));
            const remainingBorder = "─".repeat(Math.max(0, innerWidth + 1 - visibleWidth(title)));
            const top = `╭─${titleText}${theme.fg("muted", remainingBorder)}╮`;
            const rows = items.slice(0, 4).map((item) => {
                const failed = item.exitCode !== -1 && (item.exitCode !== 0 || item.stopReason === "error");
                const icon = item.exitCode === -1 ? theme.fg("warning", "◌") : failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
                const status = item.exitCode === -1 ? "running" : failed ? "failed" : "complete";
                const activity = item.activity || status;
                const row = `${icon} ${theme.fg("accent", theme.bold(item.agent))} ${theme.fg("muted", "·")} ${theme.fg("dim", activity)}`;
                return `│ ${fit(row, innerWidth)} │`;
            });
            if (items.length > 4) rows.push(`│ ${fit(theme.fg("muted", `+${items.length - 4} more subagents`), innerWidth)} │`);
            return [top, ...rows, `╰${"─".repeat(innerWidth + 2)}╯`];
        },
    });
}
