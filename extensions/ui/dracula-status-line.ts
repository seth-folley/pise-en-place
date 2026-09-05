import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
    clearContextUsageDisplayState,
    createContextUsageDisplayState,
    getContextUsageDisplay,
    recordAssistantContextUsage,
} from "../../src/shared/context-usage-display.ts";

type FooterStyle = "dracula" | "minimal" | "off";

type ContextTrace = {
    event: string;
    tokens: number | null;
    percent: number | null;
    branchEntries: number;
};

const maxContextTraces = 100;

function formatCount(value: number): string {
    if (value < 1_000) return `${value}`;
    if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
    return `${(value / 1_000_000).toFixed(1)}m`;
}

function formatCurrency(value: number): string {
    if (value === 0) return "$0";
    if (value < 0.01) return `<$0.01`;
    return `$${value.toFixed(2)}`;
}

function thinkingColor(level: string): ThemeColor {
    switch (level) {
    case "off": return "thinkingOff";
    case "minimal": return "thinkingMinimal";
    case "low": return "thinkingLow";
    case "medium": return "thinkingMedium";
    case "high": return "thinkingHigh";
    case "xhigh": return "thinkingXhigh";
    default: return "dim";
    }
}

export default function (pi: ExtensionAPI) {
    let style: FooterStyle = "dracula";
    let previewVisible = false;
    let contextTracing = false;
    let contextTraces: ContextTrace[] = [];
    let lastContextTraceKey: string | undefined;
    const contextUsageDisplay = createContextUsageDisplayState();

    const traceContextUsage = (event: string, ctx: ExtensionContext) => {
        if (!contextTracing) return;

        const usage = ctx.getContextUsage();
        const trace: ContextTrace = {
            event,
            tokens: usage?.tokens ?? null,
            percent: usage?.percent ?? null,
            branchEntries: ctx.sessionManager.getBranch().length,
        };
        const traceKey = `${trace.event}:${trace.tokens}:${trace.percent}:${trace.branchEntries}`;
        if (traceKey === lastContextTraceKey) return;

        lastContextTraceKey = traceKey;
        contextTraces.push(trace);
        if (contextTraces.length > maxContextTraces) contextTraces.shift();
    };

    const formatContextTraces = () => {
        if (!contextTraces.length) return "No context samples recorded.";
        return [
            "Context trace",
            "",
            ...contextTraces.map((trace) =>
                `${trace.event.padEnd(20)} tokens=${trace.tokens ?? "unknown"}  percent=${trace.percent === null ? "unknown" : `${trace.percent.toFixed(1)}%`}  entries=${trace.branchEntries}`,
            ),
        ].join("\n");
    };

    const installFooter = (ctx: ExtensionContext) => {
        if (style === "off") {
            ctx.ui.setFooter(undefined);
            return;
        }

        ctx.ui.setFooter((tui, theme, footerData) => {
            const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

            return {
                dispose: unsubscribe,
                invalidate() {},
                render(width: number): string[] {
                    let input = 0;
                    let output = 0;
                    let cost = 0;

                    for (const entry of ctx.sessionManager.getBranch()) {
                        if (entry.type !== "message" || entry.message.role !== "assistant") continue;

                        const message = entry.message as AssistantMessage;
                        input += message.usage?.input ?? 0;
                        output += message.usage?.output ?? 0;
                        cost += message.usage?.cost?.total ?? 0;
                    }

                    const branch = footerData.getGitBranch();
                    const statuses = [...footerData.getExtensionStatuses().values()].filter(Boolean);
                    const model = ctx.model?.id ?? "no-model";
                    const thinkingLevel = ctx.model?.reasoning ? pi.getThinkingLevel() : undefined;
                    const thinkingText = thinkingLevel
                        ? theme.fg(thinkingColor(thinkingLevel), thinkingLevel)
                        : undefined;
                    const inputText = formatCount(input);
                    const outputText = formatCount(output);
                    const totalText = formatCount(input + output);
                    const costText = formatCurrency(cost);
                    const liveContextUsage = ctx.getContextUsage();
                    const contextUsage = getContextUsageDisplay(contextUsageDisplay, {
                        tokens: liveContextUsage?.tokens ?? null,
                        percent: liveContextUsage?.percent ?? null,
                    });
                    const contextPercent = contextUsage.percent;
                    const contextWidth = 20;
                    const contextRatio = contextPercent === null || contextPercent === undefined
                        ? 0
                        : Math.max(0, Math.min(1, contextPercent / 100));
                    const contextFill = Math.round(contextRatio * contextWidth);
                    const contextColor = contextPercent === null || contextPercent === undefined
                        ? "dim"
                        : contextPercent >= 70
                            ? "error"
                            : contextPercent >= 55
                                ? "bashMode"
                                : contextPercent >= 40
                                    ? "warning"
                                    : "success";
                    const contextPercentText = contextPercent === null || contextPercent === undefined
                        ? "--%"
                        : `${contextUsage.estimated ? "~" : ""}${Math.round(contextPercent)}%`;
                    const contextFilled = "█".repeat(contextFill);
                    const contextEmpty = "░".repeat(contextWidth - contextFill);

                    if (style === "minimal") {
                        const left =
                            theme.fg("accent", "π") +
                            theme.fg("dim", ` ${model}`) +
                            (thinkingText ? theme.fg("dim", " · ") + thinkingText : "");
                        const right = branch ? theme.fg("muted", branch) : "";
                        const tokenUsage =
                            theme.fg("muted", "↑ ") +
                            theme.fg("text", inputText) +
                            theme.fg("dim", " · ") +
                            theme.fg("muted", "↓ ") +
                            theme.fg("text", outputText) +
                            theme.fg("dim", " · ") +
                            theme.fg("muted", "Σ ") +
                            theme.fg("text", totalText) +
                            theme.fg("dim", " · ") +
                            theme.fg("warning", costText);
                        const context =
                            theme.fg(contextColor, contextPercentText) +
                            theme.fg("dim", " ") +
                            theme.fg(contextColor, contextFilled) +
                            theme.fg("dim", contextEmpty);
                        const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
                        const usagePad =
                            " ".repeat(Math.max(1, width - visibleWidth(tokenUsage) - visibleWidth(context)));
                        return [
                            truncateToWidth(left + pad + right, width),
                            truncateToWidth(tokenUsage + usagePad + context, width),
                        ];
                    }

                    const modelPart =
                        theme.fg("text", model) +
                        (thinkingText ? theme.fg("dim", " ") + thinkingText : "");
                    const leftParts = [
                        theme.fg("accent", theme.bold("π")),
                        modelPart,
                        branch ? theme.fg("muted", ` ${branch}`) : undefined,
                    ].filter((part): part is string => Boolean(part));

                    const statusText = statuses.length > 0 ? statuses.join(theme.fg("dim", " · ")) : "ready";
                    const left = leftParts.join(theme.fg("dim", " · "));
                    const right = theme.fg("muted", statusText);
                    const tokenUsage =
                        theme.fg("muted", "↑ ") +
                        theme.fg("text", inputText) +
                        theme.fg("dim", " │ ") +
                        theme.fg("muted", "↓ ") +
                        theme.fg("text", outputText) +
                        theme.fg("dim", " │ ") +
                        theme.fg("muted", "Σ ") +
                        theme.fg("text", totalText) +
                        theme.fg("dim", " │ ") +
                        theme.fg("warning", costText);
                    const context =
                        theme.fg(contextColor, contextPercentText) +
                        theme.fg("dim", " ") +
                        theme.fg(contextColor, contextFilled) +
                        theme.fg("dim", contextEmpty);
                    const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
                    const usagePad =
                        " ".repeat(Math.max(1, width - visibleWidth(tokenUsage) - visibleWidth(context)));

                    return [
                        truncateToWidth(left + pad + right, width),
                        truncateToWidth(tokenUsage + usagePad + context, width),
                    ];
                },
            };
        });
    };

    pi.on("session_start", async (_event, ctx) => {
        clearContextUsageDisplayState(contextUsageDisplay);
        installFooter(ctx);
        ctx.ui.setTitle("π · Dracula Pro");
    });

    pi.on("session_compact", async (_event, ctx) => {
        clearContextUsageDisplayState(contextUsageDisplay);
        traceContextUsage("session_compact", ctx);
    });
    pi.on("model_select", async (_event, ctx) => {
        clearContextUsageDisplayState(contextUsageDisplay);
        traceContextUsage("model_select", ctx);
    });
    pi.on("agent_start", async (_event, ctx) => traceContextUsage("agent_start", ctx));
    pi.on("message_start", async (event, ctx) => traceContextUsage(`message_start:${event.message.role}`, ctx));
    pi.on("message_end", async (event, ctx) => {
        if (event.message.role === "assistant") {
            const usage = ctx.getContextUsage();
            recordAssistantContextUsage(contextUsageDisplay, event.message, {
                tokens: usage?.tokens ?? null,
                percent: usage?.percent ?? null,
            });
        }
        traceContextUsage(`message_end:${event.message.role}`, ctx);
    });
    pi.on("tool_execution_start", async (event, ctx) => traceContextUsage(`tool_execution_start:${event.toolName}`, ctx));
    pi.on("tool_execution_end", async (event, ctx) => traceContextUsage(`tool_execution_end:${event.toolName}`, ctx));
    pi.on("agent_settled", async (_event, ctx) => traceContextUsage("agent_settled", ctx));

    pi.registerCommand("statusline", {
        description: "Cycle Dracula status line style, or trace context usage with /statusline debug",
        handler: async (args, ctx) => {
            if (args.trim() === "debug") {
                contextTracing = !contextTracing;
                if (contextTracing) {
                    contextTraces = [];
                    lastContextTraceKey = undefined;
                    traceContextUsage("trace-enabled", ctx);
                    ctx.ui.notify("Context tracing enabled. Run the suspected turn, then use /statusline debug again to view the trace.", "info");
                } else {
                    ctx.ui.notify(formatContextTraces(), "info");
                }
                return;
            }

            style = style === "dracula" ? "minimal" : style === "minimal" ? "off" : "dracula";
            installFooter(ctx);
            ctx.ui.notify(`Status line: ${style}`, "info");
        },
    });

    pi.registerCommand("statusline-colors", {
        description: "Toggle Dracula status line context indicator color examples",
        handler: async (_args, ctx) => {
            previewVisible = !previewVisible;

            if (!previewVisible) {
                ctx.ui.setWidget("dracula-status-line-preview", undefined);
                ctx.ui.notify("Status line color preview hidden", "info");
                return;
            }

            const theme = ctx.ui.theme;
            const example = (label: string, color: ThemeColor, percent: string, bar: string) =>
                theme.fg("dim", label.padEnd(9)) +
                theme.fg(color, percent.padStart(4)) +
                theme.fg("dim", " ") +
                theme.fg(color, bar.replace(/░/g, "")) +
                theme.fg("dim", "░".repeat((bar.match(/░/g) ?? []).length));

            ctx.ui.setWidget("dracula-status-line-preview", [
                theme.fg("accent", theme.bold("Context indicator colors")),
                example("unknown", "dim", "--%", "░░░░░░░░░░░░"),
                example("low", "success", "25%", "███░░░░░░░░░"),
                example("medium", "warning", "45%", "█████▍░░░░░░"),
                example("warm", "bashMode", "60%", "███████▏░░░░"),
                example("limit", "error", "70%", "████████▍░░░"),
                example("high", "error", "90%", "██████████▊░"),
            ]);
            ctx.ui.notify("Status line color preview shown", "info");
        },
    });
}
