import { estimateTokens, type ExtensionAPI, type ExtensionContext, type CustomMessageEntryDraft } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AUTOCOMPACT_STATUS_EVENT, AUTOCOMPACT_STATUS_REQUEST, AUTOCOMPACT_SYMBOL } from "../../../src/shared/autocompact-status.ts";
import { configPath, defaults, loadConfig, saveConfig, type AutoCompactConfig } from "./config.ts";
import { CompactionCycle, effectiveCeiling } from "./policy.ts";
import { estimateProjectedTokens, MAX_HANDOFF_NOTE_CHARS, summarize } from "./summary.ts";

function contextMessage(content: string): CustomMessageEntryDraft {
    return { type: "custom_message", customType: "autocompact", content, display: false };
}

export default function autoCompact(pi: ExtensionAPI): void {
    let config: AutoCompactConfig = { ...defaults };
    const cycle = new CompactionCycle();
    let generation = 0;
    let compacting = false;
    let activeSessionId: string | undefined;
    let pending: { instructions: string[]; notes: string[] } | undefined;

    function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
        if (ctx.hasUI) ctx.ui.notify(text, level);
    }

    function publishStatus(): void {
        if (activeSessionId) pi.events.emit(AUTOCOMPACT_STATUS_EVENT, { sessionId: activeSessionId, ...config });
    }

    pi.events.on(AUTOCOMPACT_STATUS_REQUEST, (sessionId) => {
        if (sessionId === activeSessionId) publishStatus();
    });

    function reset(): void {
        generation++;
        compacting = false;
        pending = undefined;
        cycle.reset();
    }

    function ceiling(ctx: ExtensionContext): number {
        return effectiveCeiling(config.ceilingTokens, ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow);
    }

    pi.on("session_start", async (_event, ctx) => {
        reset();
        activeSessionId = ctx.sessionManager.getSessionId();
        try {
            config = await loadConfig();
        } catch (error) {
            config = { ...defaults };
            notify(ctx, `Autocompact disabled: ${String(error)}`, "error");
        }
        publishStatus();
    });
    pi.on("session_shutdown", () => {
        activeSessionId = undefined;
        reset();
    });
    pi.on("session_tree", reset);
    pi.on("model_select", () => cycle.reset());
    pi.on("session_compact", () => {
        // A native/manual compaction supersedes any pending handoff or in-flight
        // summary built from the old projection.
        reset();
        cycle.compacted();
    });

    pi.on("turn_end", async (event, ctx) => {
        if (compacting) return;
        // Failed/aborted turns belong to Pi's recovery lifecycle, not ours.
        if (ctx.signal?.aborted || event.outcome !== "completed" || (event.message.role === "assistant" &&
            (["aborted", "error"].includes(event.message.stopReason) ||
                (event.message.stopReason === "length" && !event.message.content.some(part => part.type === "toolCall"))))) {
            pending = undefined;
            return;
        }
        const requested = pending;
        const limit = ceiling(ctx);
        const usageTokens = ctx.getContextUsage()?.tokens;
        // Usage belongs to the committed transcript. Edits/compaction invalidate it;
        // otherwise account for any context messages proposed by earlier handlers.
        const tokens = event.entries.some(entry => entry.type === "context_edit" || entry.type === "compaction")
            ? estimateProjectedTokens(event.context.contextEntries)
            : usageTokens == null ? usageTokens : usageTokens + event.entries.reduce((sum, entry) =>
                sum + (entry.type === "custom_message" ? estimateTokens({
                    role: "custom", customType: entry.customType, content: entry.content,
                    display: entry.display, details: entry.details, timestamp: 0,
                }) : 0), 0);
        const action = config.enabled ? cycle.observe(tokens, limit) : undefined;
        if (requested || action === "compact") {
            pending = undefined;
            compacting = true;
            cycle.markAttempt();
            const startedGeneration = generation;
            notify(ctx, "Compacting context…");
            try {
                // Boundary previews include prior handlers' proposed edits. Returning
                // a draft lets Pi commit atomically before the next response, without
                // aborting the run or interfering with steering/follow-up queues.
                const draft = await summarize(
                    event.context.contextEntries, ctx, limit,
                    requested?.instructions.join("\n\n"), requested?.notes.join("\n\n") || undefined,
                );
                if (generation !== startedGeneration) return;
                if (ctx.signal?.aborted) { cycle.reset(); return; }
                cycle.compacted();
                notify(ctx, "Context compaction completed.");
                // Do not force continuation: the ordinary tool/queue scheduler
                // determines whether another response is needed.
                return { entries: [...event.entries, draft] };
            } catch (error) {
                if (generation !== startedGeneration) return;
                if (ctx.signal?.aborted) { cycle.reset(); return; }
                const text = `Compaction failed: ${String(error)}. The run was paused. Use /compact to retry before continuing.`;
                notify(ctx, text, "error");
                ctx.abort();
                return { entries: [...event.entries, contextMessage(text)] };
            } finally {
                if (generation === startedGeneration) compacting = false;
            }
        }
        if (action === "blocked") {
            const text = "Context remains above the autocompact ceiling after a compaction attempt. The run was paused; " +
                "use /compact or change /autocompact settings before continuing.";
            notify(ctx, text, "warning");
            ctx.abort();
            return { entries: [...event.entries, contextMessage(text)] };
        }
        if (action === 80 || action === 90) {
            const advice = action === 90
                ? "Continue the task normally; automatic compaction will handle the ceiling. Manual compaction is optional at a natural stopping point, " +
                    "not required. Do not interrupt useful work just to compact or write a handoff note."
                : "Informational only: continue the task normally. Automatic compaction will handle the ceiling. " +
                    "No compaction call or handoff note is needed now.";
            const text = `Context warning (${action}% threshold): approximately ${tokens?.toLocaleString()} / ${limit.toLocaleString()} tokens. ${advice}`;
            notify(ctx, text, "warning");
            return { entries: [...event.entries, contextMessage(text)] };
        }
    });

    pi.registerTool({
        name: "compact_context",
        label: "Compact context",
        description: "Request manual context compaction after this tool batch completes, then continue the unfinished task. " +
            "Normally keep working and let enabled automatic compaction handle the ceiling. Use this tool when the user requests compaction, " +
            "or optionally at a natural stopping point after a 90% context warning. Do not compact merely because the conversation feels long, " +
            "to finish a task, or to leave a note. Optional instructions guide the summary. An optional note (up to 1,000 characters) is appended " +
            "verbatim as an Agent handoff note: concrete next actions, unfinished checks, or constraints—not a reasoning transcript. " +
            "The tool queues compaction; its result does not mean compaction has completed. Works even when /autocompact is off.",
        parameters: Type.Object({
            instructions: Type.Optional(Type.String({ maxLength: 8000, description: "What the compaction summary should preserve." })),
            note: Type.Optional(Type.String({ maxLength: MAX_HANDOFF_NOTE_CHARS, description: "Short note to the next assistant, appended verbatim after the summary. Include next action, unfinished checks, or constraints." })),
        }),
        async execute(_toolCallId, params, signal) {
            if (signal?.aborted) throw new Error("Compaction request cancelled");
            if (compacting) throw new Error("Compaction is already in progress");
            const instructions = [...pending?.instructions ?? []];
            if (params.instructions?.trim()) instructions.push(params.instructions.trim());
            if (instructions.join("\n\n").length > 8000) throw new Error("Combined compaction instructions exceed 8,000 characters");
            const notes = [...pending?.notes ?? []];
            if (params.note?.trim()) notes.push(params.note);
            if (Array.from(notes.join("\n\n")).length > MAX_HANDOFF_NOTE_CHARS) throw new Error("Combined agent handoff notes exceed 1,000 characters");
            // Validate before replacing pending state. Parallel requests coalesce;
            // preserve each note verbatim with a blank line between them.
            pending = { instructions, notes };
            return {
                content: [{ type: "text", text: "Compaction queued for the end of this tool batch. Normal task execution continues after successful compaction." }],
                details: { queued: true },
            };
        },
    });

    pi.registerCommand("autocompact", {
        description: "Show current usage and limits, enable/disable automatic compaction, or set its ceiling: [status|on|off|ceiling <tokens>]",
        getArgumentCompletions: (prefix) => {
            const options = [
                { value: "status", label: "status", description: "Show current usage and compaction limits" },
                { value: "on", label: "on", description: "Enable automatic compaction" },
                { value: "off", label: "off", description: "Disable this strategy; leave native Pi compaction unchanged" },
                { value: "ceiling", label: "ceiling", description: "Set the token ceiling: ceiling <tokens>" },
            ];
            const matches = options.filter(option => option.value.startsWith(prefix.trimStart()));
            return matches.length ? matches : null;
        },
        handler: async (args, ctx) => {
            const parts = args.trim().split(/\s+/).filter(Boolean);
            let patch: Partial<AutoCompactConfig> | undefined;
            if (parts.length === 1 && (parts[0] === "on" || parts[0] === "off")) {
                patch = { enabled: parts[0] === "on" };
            } else if (parts.length === 2 && parts[0] === "ceiling" && /^\d+$/.test(parts[1]!)) {
                patch = { ceilingTokens: Number(parts[1]) };
            } else if (parts.length > 0 && !(parts.length === 1 && parts[0] === "status")) {
                notify(ctx, "Usage: /autocompact [status|on|off|ceiling <tokens>]", "warning");
                return;
            }
            try {
                config = patch ? await saveConfig(patch) : await loadConfig();
                if (patch) cycle.reset();
                publishStatus();
                const limit = ceiling(ctx);
                const tokens = ctx.getContextUsage()?.tokens;
                const current = tokens == null || !Number.isFinite(tokens) || tokens < 0
                    ? "unknown (waiting for reliable context usage)"
                    : `${tokens.toLocaleString()} tokens (${(tokens / limit * 100).toFixed(1)}% of effective ceiling)`;
                const row = (label: string, value: string) => `  ${label.padEnd(14)}${value}`;
                notify(ctx, [
                    `${AUTOCOMPACT_SYMBOL} Autocompact · ${config.enabled ? "enabled" : "disabled"}`,
                    "",
                    row("Current", current),
                    row("Ceiling", `${config.ceilingTokens.toLocaleString()} tokens`),
                    row("Effective", `${limit.toLocaleString()} tokens`),
                    "",
                    row("Warning 80%", `${Math.ceil(limit * 0.8).toLocaleString()} tokens`),
                    row("Warning 90%", `${Math.ceil(limit * 0.9).toLocaleString()} tokens`),
                    "",
                    "Pi's native compaction is unchanged.",
                    `Settings: ${configPath()}`,
                ].join("\n"));
            } catch (error) {
                notify(ctx, `Autocompact settings unchanged: ${String(error)}`, "error");
            }
        },
    });
}
