/*
 * Pi roadmap writer extension.
 *
 * Adds /roadmap for delegating ROADMAP.md edits to a separate non-interactive
 * Pi process. The child process runs with no session and no discovered
 * extensions/skills/templates, but explicitly loads the usage ledger extension
 * so model usage is still tracked.
 */

import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { readAgentCompletionJson } from "../../src/shared/agent-completion-json.ts";
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
    return stripVTControlCharacters(value).trim();
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
            let before: Buffer;
            try {
                before = await readFile(roadmapPath);
            } catch (error) {
                const message = (error as NodeJS.ErrnoException)?.code === "ENOENT"
                    ? `Cannot find ${roadmapFile} in ${ctx.cwd}.`
                    : `Cannot read ${roadmapFile} before the run: ${errorText(error)}`;
                ctx.ui.notify(message, "error");
                return;
            }

            ctx.ui.notify(`Updating ${roadmapFile} in an isolated Pi process...`, "info");

            let result: ExecResult | undefined;
            let executionError: string | undefined;
            try {
                result = await pi.exec(
                    "pi",
                    [
                        "--print",
                        "--mode", "json",
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
            } catch (error) { executionError = errorText(error); }

            // Compare against this invocation's bytes, not Git's baseline: the file may
            // already be dirty, and /roadmap also works outside a Git repository.
            let changed: boolean | undefined;
            let verificationError: string | undefined;
            try { changed = !before.equals(await readFile(roadmapPath)); }
            catch (error) { verificationError = errorText(error); }

            const { completion, valid } = readAgentCompletionJson(result?.stdout ?? "");
            const outcome = completion.outcome({ aborted: result?.killed, exitCode: result?.code });
            const completed = result?.code === 0 && valid && outcome === "completed";
            const response = stripAnsi(completion.finalText);
            if (completed && changed !== undefined) {
                const title = changed ? `${roadmapFile} updated outside the current context.`
                    : `No content change detected in ${roadmapFile} during this run.`;
                ctx.ui.notify(`${title}${response ? `\n\n${response}` : ""}`, "info");
                return;
            }

            const diagnosis = [
                executionError,
                !valid ? "Child completion output was malformed or incomplete." : undefined,
                !executionError && outcome !== "completed" ? completion.description(outcome) : undefined,
            ].filter(Boolean).join("\n");
            const details = stripAnsi([
                diagnosis,
                completion.stopReason === "length" && outcome !== "truncated" ? completion.description("truncated") : undefined,
                result?.killed ? "The child process was terminated (timeout or abort)." : undefined,
                result && result.code !== 0 ? `Child process exit code: ${result.code}.` : undefined,
                result?.stderr,
                verificationError ? `Could not inspect ${roadmapFile} after the run: ${verificationError}` : undefined,
            ].filter(Boolean).join("\n"));
            const title = changed === true
                ? `${roadmapFile} changed during the run, but completion could not be confirmed. Review it before rerunning; this command did not rerun the task or roll back changes.`
                : changed === false
                    ? `Roadmap child completion was not confirmed. No content change was detected in ${roadmapFile}. Check any other requested files before rerunning.`
                    : `Roadmap result could not be verified after the run. Do not assume no changes; inspect ${roadmapFile} and any other requested files before rerunning.`;
            // Partial work is not transactional failure. Leave all on-disk work untouched.
            ctx.ui.notify([
                title,
                response ? `Available response evidence:\n${response}` : undefined,
                details || undefined,
            ].filter(Boolean).join("\n\n"), changed === false ? "error" : "warning");
        },
    });
}
