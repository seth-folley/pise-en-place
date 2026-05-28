/*
 * Pi roadmap writer extension.
 *
 * Adds /roadmap for delegating ROADMAP.md edits to a separate non-interactive
 * Pi process. The child process runs with no session and no discovered
 * extensions/skills/templates, but explicitly loads the usage ledger extension
 * so model usage is still tracked.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const commandName = "roadmap";
const roadmapFile = "ROADMAP.md";
const timeoutMs = 10 * 60 * 1000;
const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const usageLedgerExtension = path.resolve(extensionDir, "..", "usage", "index.ts");

function buildPrompt(request: string): string {
    return `You are a focused roadmap-editing agent running in a separate Pi process.

Task: update ${roadmapFile} for this repository according to the user's request.

User request:
${request}

Rules:
- Read ${roadmapFile} before editing it.
- Edit only ${roadmapFile} unless the user explicitly asks for another file.
- Preserve the roadmap's current organization: top-level status sections, then topical subsections.
- Keep entries concise and human-readable.
- Do not mention this child process in the roadmap.
- After editing, respond with a brief summary of what changed.`;
}

function stripAnsi(value: string): string {
    return value.replace(/\u001B\[[0-9;]*m/g, "").trim();
}

function usageText(): string {
    return `Usage: /${commandName} <roadmap change request>\n\nExample: /${commandName} Add an idea for skill usage tracking in usage reports`;
}

export default function (pi: ExtensionAPI) {
    pi.registerCommand(commandName, {
        description: "Update ROADMAP.md via an isolated non-interactive Pi process",
        handler: async (args, ctx) => {
            const request = args.trim();
            if (!request || request === "--help" || request === "-h") {
                ctx.ui.notify(usageText(), "info");
                return;
            }

            const roadmapPath = path.join(ctx.cwd, roadmapFile);
            try {
                await access(roadmapPath);
            } catch {
                ctx.ui.notify(`Cannot find ${roadmapFile} in ${ctx.cwd}.`, "error");
                return;
            }

            ctx.ui.notify(`Updating ${roadmapFile} in an isolated Pi process...`, "info");

            const result = await pi.exec(
                "pi",
                [
                    "--print",
                    "--no-session",
                    "--no-extensions",
                    "--extension",
                    usageLedgerExtension,
                    "--no-skills",
                    "--no-prompt-templates",
                    "--no-themes",
                    "--no-context-files",
                    "--tools",
                    "read,edit,write",
                    buildPrompt(request),
                ],
                { cwd: ctx.cwd, timeout: timeoutMs }
            );

            const stdout = stripAnsi(result.stdout ?? "");
            const stderr = stripAnsi(result.stderr ?? "");

            if (result.code === 0) {
                const summary = stdout ? `\n\n${stdout}` : "";
                ctx.ui.notify(`${roadmapFile} updated outside the current context.${summary}`, "info");
                return;
            }

            const details = [stdout, stderr].filter(Boolean).join("\n\n") || "No output.";
            ctx.ui.notify(`Roadmap update failed outside the current context.\n\n${details}`, "error");
        },
    });
}
