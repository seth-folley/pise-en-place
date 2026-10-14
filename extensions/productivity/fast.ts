import { clampThinkingLevel, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FAST_STATUS_EVENT, FAST_STATUS_REQUEST, supportsFast, type FastStatus } from "../../src/shared/fast-status.ts";

const usage = "Usage: /fast [on|off|status]";

export default function fast(pi: ExtensionAPI): void {
    let current: ExtensionContext | undefined;
    let enabled = false;
    let generation = 0;
    let selection = "";
    const wrapped = new Map<string, Provider>();

    function available(ctx: ExtensionContext): boolean {
        if (!supportsFast(ctx.model)) return false;
        const id = ctx.model!.provider;
        return !ctx.modelRegistry.getRegisteredProviderIds().includes(id) ||
            ctx.modelRegistry.getRegisteredNativeProvider(id) === wrapped.get(id) && wrapped.has(id);
    }

    const key = (model: Model<Api> | undefined) => model ? `${model.provider}/${model.id}` : "";
    const notify = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info") => {
        if (ctx.hasUI) ctx.ui.notify(text, level);
    };
    function publish(): void {
        if (!current) return;
        const status: FastStatus = {
            sessionId: current.sessionManager.getSessionId(),
            provider: current.model?.provider ?? "",
            model: current.model?.id ?? "",
            enabled: enabled && available(current) && key(current.model) === selection,
        };
        pi.events.emit(FAST_STATUS_EVENT, status);
    }
    function reset(ctx?: ExtensionContext): void {
        generation++;
        enabled = false;
        current = ctx;
        selection = key(ctx?.model);
        publish();
    }

    pi.events.on(FAST_STATUS_REQUEST, sessionId => {
        if (sessionId === current?.sessionManager.getSessionId()) publish();
    });
    pi.on("session_start", (_event, ctx) => reset(ctx));
    pi.on("session_shutdown", () => reset());
    pi.on("session_tree", (_event, ctx) => reset(ctx));
    pi.on("model_select", (_event, ctx) => {
        if (key(ctx.model) !== selection) reset(ctx);
        else { current = ctx; publish(); }
    });

    pi.on("before_agent_start", (_event, ctx) => {
        current = ctx;
        if (enabled && (!available(ctx) || key(ctx.model) !== selection)) {
            reset(ctx);
            notify(ctx, "Fast mode OFF: the model or provider registration changed. Run /fast on again if supported.", "warning");
        }
    });

    pi.on("message_end", (event, ctx) => {
        const message = event.message;
        if (!enabled || message.role !== "assistant" || message.stopReason !== "error" ||
            `${message.provider}/${message.model}` !== selection) return;
        const error = message.errorMessage ?? "";
        if (/(?:service[_ -]?tier|priority)/i.test(error) &&
            /(?:unsupported|not supported|unavailable|not available|not allowed|not eligible|invalid|denied|rejected)/i.test(error)) {
            notify(ctx, "OpenAI rejected the priority request. Fast mode remains requested; use /fast off before retrying. The original provider error is unchanged.", "warning");
        }
    });

    function installProvider(ctx: ExtensionContext): void {
        const id = ctx.model!.provider;
        if (wrapped.has(id) && ctx.modelRegistry.getRegisteredNativeProvider(id) === wrapped.get(id)) return;
        const provider = ctx.modelRegistry.getProvider(id);
        if (!provider) throw new Error(`Provider ${id} is unavailable`);
        const replacement: Provider = {
            ...provider,
            streamSimple(model, context, options) {
                // Restrict to this session's selected physical model. Compaction,
                // summaries, and nested calls have separate/no session routing ids.
                if (!enabled || !current || current.isIdle() || !available(current) || !supportsFast(model) ||
                    key(current.model) !== selection || key(model) !== selection ||
                    options?.sessionId !== current.sessionManager.getSessionId()) {
                    return provider.streamSimple(model, context, options);
                }
                // Pi 1.2's streamSimple strips serviceTier in buildBaseOptions.
                // Reuse its conversion helpers, then delegate to native stream so
                // BOTH transports and native tier pricing receive the option.
                const level = options.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
                return provider.stream(model, context, {
                    ...buildBaseOptions(model, context, options, options.apiKey),
                    toolChoice: options.toolChoice,
                    reasoningEffort: level === "off" ? undefined : level,
                    serviceTier: "priority",
                });
            },
        };
        pi.registerProvider(replacement);
        wrapped.set(id, replacement);
    }

    pi.registerCommand("fast", {
        description: "Toggle OpenAI priority service for this session: [on|off|status] (additional cost/usage)",
        getArgumentCompletions: prefix => {
            const matches = ["on", "off", "status"].filter(value => value.startsWith(prefix.trimStart()));
            return matches.length ? matches.map(value => ({ value, label: value })) : null;
        },
        handler: async (args, ctx) => {
            const action = args.trim();
            if (!["", "on", "off", "status"].includes(action)) { notify(ctx, usage, "warning"); return; }
            if (action === "status") {
                current = ctx;
                if (enabled && (!available(ctx) || key(ctx.model) !== selection)) reset(ctx);
                const active = enabled && key(ctx.model) === selection && available(ctx);
                notify(ctx, `Fast mode: ${active ? "ON (priority requested; acceleration not guaranteed)" : "OFF"}. ` +
                    (available(ctx) ? "Native OpenAI Responses connection; model/account eligibility is not verified." :
                        "Unavailable: requires a native openai/openai-codex Responses connection without another extension's provider registration."));
                return;
            }
            const started = generation;
            const sessionId = ctx.sessionManager.getSessionId();
            await ctx.waitForIdle();
            if (started !== generation || sessionId !== current?.sessionManager.getSessionId()) {
                if (current) notify(current, "Fast mode unchanged: session or model changed while waiting. Run /fast again.", "warning");
                return;
            }
            current = ctx;
            const next = action === "off" ? false : action === "on" ? true : !enabled;
            if (next && !available(ctx)) {
                notify(ctx, "Fast mode unavailable: requires a native openai/openai-codex Responses connection without another extension's provider registration.", "warning");
                return;
            }
            if (next) {
                try { installProvider(ctx); }
                catch (error) { notify(ctx, `Fast mode unchanged: ${String(error)}`, "error"); return; }
            }
            enabled = next;
            selection = key(ctx.model);
            publish();
            notify(ctx, next
                ? "Fast mode ON: requesting OpenAI priority service. Additional cost/usage may apply; model/account eligibility and acceleration are not guaranteed. Thinking level is unchanged."
                : "Fast mode OFF.", next ? "warning" : "info");
        },
    });
}
