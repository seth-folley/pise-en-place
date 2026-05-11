import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

let enabled = true;
let startedAt: bigint | undefined;
let lastElapsed: string | undefined;

function formatDuration(start: bigint, end: bigint): string {
    const milliseconds = Number(end - start) / 1_000_000;

    if (milliseconds < 1_000) {
        return `${Math.round(milliseconds)}ms`;
    }

    const seconds = milliseconds / 1_000;

    if (seconds < 60) {
        return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
    }

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    return `${minutes}m ${remainingSeconds}s`;
}

function setStatus(ctx: ExtensionContext, text: string | undefined, color: "accent" | "success" = "accent") {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("response-time", text ? ctx.ui.theme.fg(color, text) : undefined);
}

export default function (pi: ExtensionAPI) {
    pi.on("session_start", async (_event, ctx) => {
        setStatus(ctx, lastElapsed ? `⏱ last response: ${lastElapsed}` : "ready");
    });

    pi.on("agent_start", async (_event, ctx) => {
        if (!enabled) return;

        startedAt = process.hrtime.bigint();
        setStatus(ctx, "⏱ responding…", "accent");
    });

    pi.on("agent_end", async (_event, ctx) => {
        if (!enabled || !startedAt) return;

        lastElapsed = formatDuration(startedAt, process.hrtime.bigint());
        startedAt = undefined;

        setStatus(ctx, `⏱ last response: ${lastElapsed}`, "success");
    });

    pi.registerCommand("response-time", {
        description: "Toggle reporting how long each agent response took",
        handler: async (_args, ctx) => {
            enabled = !enabled;
            startedAt = undefined;

            if (enabled) {
                setStatus(ctx, lastElapsed ? `⏱ last response: ${lastElapsed}` : "ready", "dim");
                ctx.ui.notify("Response time reporting enabled", "info");
            } else {
                setStatus(ctx, undefined);
                ctx.ui.notify("Response time reporting disabled", "info");
            }
        },
    });
}
