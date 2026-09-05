import { Container, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type SubagentToolTask = { agent: string; task: string };
export type SubagentToolResult = SubagentToolTask & { exitCode: number; stopReason?: string; activity?: string; output?: string; stderr?: string };
export type SubagentToolDetails = { mode: "single" | "parallel"; results: SubagentToolResult[] };

type Theme = {
    fg(color: string, text: string): string;
    bold(text: string): string;
};

type ToolArgs = { agent?: string; task?: string; tasks?: SubagentToolTask[] };

export function tasksFromArgs(args: ToolArgs): SubagentToolTask[] {
    return args.tasks?.length ? args.tasks : args.agent && args.task ? [{ agent: args.agent, task: args.task }] : [];
}

export function subagentStatus(results: SubagentToolResult[], mode: "single" | "parallel"): string {
    if (!results.length) return mode === "parallel" ? "0 parallel" : "starting";
    const complete = results.filter((result) => result.exitCode !== -1).length;
    const failures = results.filter((result) => result.exitCode !== -1 && (result.exitCode !== 0 || result.stopReason === "error")).length;
    if (complete < results.length) return mode === "parallel" ? `${results.length} parallel` : "running";
    if (failures) return `${complete - failures}/${results.length} complete · ${failures} failed`;
    return `${complete}/${results.length} complete`;
}

class SubagentHeader {
    constructor(private theme: Theme, private status: string) {}

    set(theme: Theme, status: string): void {
        this.theme = theme;
        this.status = status;
    }

    invalidate(): void {}

    render(width: number): string[] {
        const right = this.theme.fg("muted", this.status);
        const rawLeft = "Subagents";
        const left = this.theme.fg("toolTitle", this.theme.bold(rawLeft));
        const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
        if (gap > 1) return [`${left}${" ".repeat(gap)}${right}`];
        return [truncateToWidth(`${left} ${right}`, width)];
    }
}

export function renderSubagentCall(args: ToolArgs, theme: Theme, context: { state: Record<string, unknown>; lastComponent?: unknown }) {
    const tasks = tasksFromArgs(args);
    const mode = tasks.length > 1 ? "parallel" : "single";
    const status = subagentStatus(tasks.map((task) => ({ ...task, exitCode: -1 })), mode);
    const header = context.lastComponent instanceof SubagentHeader ? context.lastComponent : new SubagentHeader(theme, status);
    header.set(theme, status);
    context.state.subagentHeader = header;
    return header;
}

export function renderSubagentResult(
    result: { content: Array<{ type: string; text?: string }>; details?: unknown },
    options: { expanded: boolean; isPartial?: boolean },
    theme: Theme,
    context: { state: Record<string, unknown> },
) {
    const details = result.details as SubagentToolDetails | undefined;
    if (!details) {
        const content = result.content[0];
        return new Text(content?.type === "text" ? content.text ?? "" : "", 0, 0);
    }

    const status = subagentStatus(details.results, details.mode);
    const header = context.state.subagentHeader;
    // The surrounding tool component is already being rendered. Invalidating it
    // from its own render callback recursively appends the result component.
    if (header instanceof SubagentHeader) header.set(theme, status);

    if (!options.expanded) return new Container();

    let text = "";
    for (const item of details.results) {
        const failed = item.exitCode !== -1 && (item.exitCode !== 0 || item.stopReason === "error");
        const icon = item.exitCode === -1 ? theme.fg("warning", "◌") : failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const statusText = item.exitCode === -1 ? item.activity ?? "running" : failed ? "failed" : "completed";
        text += `${icon} ${theme.fg("accent", theme.bold(item.agent))} ${theme.fg("muted", `· ${statusText}`)}\n`;
        text += `  ${theme.fg("muted", "Task:")} ${theme.fg("dim", item.task)}\n`;
        const output = item.output || item.stderr || (item.exitCode === -1 ? "" : "(no response)");
        if (output) text += `  ${theme.fg("muted", "Result:")}\n${theme.fg("toolOutput", output)}\n`;
    }
    return new Text(text.trimEnd(), 0, 0);
}
