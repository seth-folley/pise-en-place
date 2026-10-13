import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { subagentOutcome, subagentOutcomeLabel, type SubagentCompletion } from "./completion.ts";

type Theme = {
    fg(color: string, text: string): string;
    bold(text: string): string;
};

export type SubagentWidgetItem = SubagentCompletion & {
    agent: string;
    activity?: string;
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
            const finished = items.length - running;
            const completed = items.filter(item => item.exitCode !== -1 && subagentOutcome(item) === "completed").length;
            const title = running
                ? ` Subagents · ${finished}/${items.length} finished · ${running} running `
                : ` Subagents · ${completed}/${items.length} complete `;
            const titleText = theme.fg("accent", theme.bold(title));
            const remainingBorder = "─".repeat(Math.max(0, innerWidth + 1 - visibleWidth(title)));
            const top = `╭─${titleText}${theme.fg("muted", remainingBorder)}╮`;
            const rows = items.slice(0, 4).map((item) => {
                const failed = item.exitCode !== -1 && subagentOutcome(item) !== "completed";
                const icon = item.exitCode === -1 ? theme.fg("warning", "◌") : failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
                const activity = item.exitCode === -1 ? item.activity || "running" : subagentOutcomeLabel(item);
                const row = `${icon} ${theme.fg("accent", theme.bold(item.agent))} ${theme.fg("muted", "·")} ${theme.fg("dim", activity)}`;
                return `│ ${fit(row, innerWidth)} │`;
            });
            if (items.length > 4) rows.push(`│ ${fit(theme.fg("muted", `+${items.length - 4} more subagents`), innerWidth)} │`);
            return [top, ...rows, `╰${"─".repeat(innerWidth + 2)}╯`];
        },
    });
}
