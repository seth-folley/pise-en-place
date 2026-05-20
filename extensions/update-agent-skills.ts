/*
 * Pi extension for shared agent skill updates.
 *
 * This extension keeps Pi focused on UI and orchestration while delegating skill
 * management domain logic to ~/.agents/scripts. It defines:
 *
 * - A custom renderer for skill update output and diff-style lines.
 * - Startup version checks that notify when pinned skills have newer tags.
 * - The /update-skills command for checking, syncing, or interactively choosing
 *   pinned version updates.
 * - A tabbed TUI picker for accepting/rejecting available skill updates.
 *
 * Script communication uses JSON contracts from check-skill-updates.sh and
 * update-skills.sh. The extension should not parse or mutate the manifest
 * directly; scripts own manifest validation, pinning, syncing, and diff artifacts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { askMultiSelectQuestion } from "./shared/interactive-questions.ts";

const updateScript = `${process.env.HOME}/.agents/scripts/update-skills.sh`;
const checkScript = `${process.env.HOME}/.agents/scripts/check-skill-updates.sh`;
const messageType = "agent-skills-output";

type NotifyLevel = "info" | "warning" | "error" | "success";
type NotifyContext = {
    hasUI: boolean;
    ui: {
        notify(message: string, level: NotifyLevel): void;
        custom<T>(factory: (...args: any[]) => any, options?: any): Promise<T>;
    };
};

type SkillUpdate = {
    name: string;
    source?: string;
    currentRef: string;
    latestRef: string;
    diffURL?: string;
    changelogURL?: string;
};

type SkillCheckResult = {
    ok: boolean;
    manifestPath?: string;
    updates: SkillUpdate[];
    skipped?: Array<{ name: string; reason: string }>;
    failures?: Array<{ name?: string; message: string }>;
};

type SkillPinResult = {
    ok: boolean;
    manifestPath?: string;
    updatedRefs: Array<{ name: string; previousRef: string; newRef: string }>;
    failures?: Array<{ name?: string; message: string }>;
};

type SkillSyncResult = {
    ok: boolean;
    manifestPath?: string;
    status?: string;
    message?: string;
    skills: Array<{
        name: string;
        ref?: string;
        skillPath?: string;
        status: string;
        message?: string;
        postProcessDiff?: {
            path: string;
            lineCount: number;
            preview?: string[];
        };
    }>;
    failures?: Array<{ name?: string; message: string }>;
};

export default function (pi: ExtensionAPI) {
    // Renders skill script output using the active theme. Summary lines use the
    // theme's normal text color; diff coloring only applies after an actual diff
    // block starts so bullet summaries such as `- swift-concurrency` stay readable.
    pi.registerMessageRenderer(messageType, (message: any, _options: any, theme: any) => {
        const content = String(message.content ?? "");
        let inDiffBlock = false;

        const rendered = content.split("\n").map((line, index) => {
            const trimmed = line.trimStart();

            if (index === 0 && trimmed.length > 0) {
                return theme.fg("accent", theme.bold(line));
            }

            if (trimmed.length === 0) {
                return line;
            }

            if (trimmed.startsWith("diff ")) {
                inDiffBlock = true;
                return theme.fg("warning", line);
            }

            if (inDiffBlock) {
                if (trimmed.startsWith("+++") || trimmed.startsWith("---")) {
                    return theme.fg("muted", line);
                }

                if (trimmed.startsWith("+")) {
                    return theme.fg("success", line);
                }

                if (trimmed.startsWith("-")) {
                    return theme.fg("error", line);
                }

                if (trimmed.startsWith("@@")) {
                    return theme.fg("accent", line);
                }
            }

            if (trimmed.startsWith("Synced ") ||
                trimmed.startsWith("Updated manifest refs:") ||
                trimmed.startsWith("Skill updates available")) {
                return theme.fg("success", line);
            }

            if (trimmed.startsWith("Diff:") ||
                trimmed.startsWith("Changelog:") ||
                trimmed.startsWith("Post-processing diff:") ||
                trimmed.startsWith("Full diff:")) {
                return theme.fg("accent", line);
            }

            if (trimmed.includes(" -> ")) {
                return theme.fg("warning", line);
            }

            return theme.fg("text", line);
        }).join("\n");

        return new Text(rendered, 0, 0);
    });

    // Executes one of the skill-management shell wrappers and merges stdout/stderr.
    async function runScript(script: string, args: string[], timeout: number) {
        const result = await pi.exec("bash", [script, ...args], { timeout });
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        return { ...result, output };
    }

    // Sends command output into the conversation using the custom renderer above.
    function showOutput(title: string, output: string) {
        pi.sendMessage({
            customType: messageType,
            content: `${title}\n\n${output || "No output."}`,
            display: true,
        });
    }

    // Calls the check script's JSON contract and returns parsed update metadata.
    async function checkSkillUpdates() {
        const result = await runScript(checkScript, ["--json"], 60_000);

        try {
            return {
                ...result,
                check: JSON.parse(result.output) as SkillCheckResult,
            };
        } catch {
            return {
                ...result,
                check: undefined,
            };
        }
    }

    // Formats structured script failures into concise user-facing lines.
    function formatFailures(failures: Array<{ name?: string; message: string }> = []) {
        return failures.map((failure) => {
            const prefix = failure.name ? `${failure.name}: ` : "";
            return `${prefix}${failure.message}`;
        }).join("\n");
    }

    // Formats the version-check result for notifications and command output.
    function formatCheckResult(check: SkillCheckResult) {
        if (check.updates.length > 0) return formatUpdates(check.updates);
        if ((check.failures ?? []).length > 0) return formatFailures(check.failures);
        return "All version-pinned skills are up to date.";
    }

    // Formats sync JSON as a concise summary with diff artifact paths.
    function formatSyncResult(sync: SkillSyncResult) {
        const lines: string[] = [];

        if (sync.message) lines.push(sync.message);

        const synced = sync.skills.filter((skill) => skill.status === "synced");
        if (synced.length > 0) {
            lines.push(`Synced ${synced.length} skill${synced.length === 1 ? "" : "s"}.`);
            for (const skill of synced) {
                const ref = skill.ref ? ` from ${skill.ref}` : "";
                const path = skill.skillPath ? ` (${skill.skillPath})` : "";
                lines.push(`- ${skill.name}${ref}${path}`);

                if (skill.postProcessDiff) {
                    lines.push(
                        `  Post-processing diff: ${skill.postProcessDiff.path} ` +
                        `(${skill.postProcessDiff.lineCount} lines)`,
                    );
                }
            }
        }

        const failed = sync.skills.filter((skill) => skill.status === "failed");
        for (const skill of failed) {
            lines.push(`- ${skill.name}: ${skill.message ?? "failed"}`);
        }

        if ((sync.failures ?? []).length > 0) {
            lines.push(formatFailures(sync.failures));
        }

        return lines.filter(Boolean).join("\n") || "No skills synced.";
    }

    // Formats one available version update including optional review links.
    function formatUpdate(update: SkillUpdate) {
        const lines = [`${update.name}: ${update.currentRef} -> ${update.latestRef}`];
        if (update.diffURL) lines.push(`Diff: ${update.diffURL}`);
        if (update.changelogURL) lines.push(`Changelog: ${update.changelogURL}`);
        return lines.join("\n");
    }

    // Formats multiple available version updates separated by blank lines.
    function formatUpdates(updates: SkillUpdate[]) {
        return updates.map(formatUpdate).join("\n\n");
    }

    // Presents available updates with the shared interactive question component.
    // All updates start selected so pressing enter applies the full batch.
    async function chooseUpdates(ctx: NotifyContext, updates: SkillUpdate[]) {
        return askMultiSelectQuestion(ctx, {
            title: "Skill updates",
            options: updates.map((update) => ({
                label: update.name,
                value: update,
                selected: true,
                renderDetails: (_option, { theme, selected, wrap }) => {
                    const lines: string[] = [];
                    lines.push(theme.fg("accent", theme.bold(update.name)));
                    lines.push(`Current: ${theme.fg("error", update.currentRef)}`);
                    lines.push(`Latest:  ${theme.fg("success", update.latestRef)}`);
                    lines.push(`Selected: ${selected ? theme.fg("success", "yes") : theme.fg("muted", "no")}`);

                    if (update.diffURL) {
                        lines.push("");
                        lines.push(theme.fg("warning", "Diff:"));
                        lines.push(...wrap(update.diffURL));
                    }

                    if (update.changelogURL) {
                        lines.push("");
                        lines.push(theme.fg("warning", "Changelog:"));
                        lines.push(...wrap(update.changelogURL));
                    }

                    return lines;
                },
            })),
        });
    }

    // Runs the startup/manual check flow and optionally notifies when current.
    //
    // Startup uses this silently unless updates are available. Manual --check uses
    // `notifyWhenCurrent` so an up-to-date result is still visible to the user.
    async function checkSkillVersions(ctx: NotifyContext, notifyWhenCurrent = false) {
        const result = await checkSkillUpdates();

        if (!result.check) {
            if (ctx.hasUI) ctx.ui.notify("Skill version check returned invalid JSON", "warning");
            return result.output;
        }

        const formattedResult = formatCheckResult(result.check);

        if (result.code !== 0 || !result.check.ok) {
            if (ctx.hasUI) ctx.ui.notify("Skill version check failed", "warning");
            return formattedResult || result.output;
        }

        if (ctx.hasUI && result.check.updates.length > 0) {
            ctx.ui.notify(
                `Skill updates available: ${result.check.updates.length}. Run /update-skills --interactive.`,
                "info",
            );
            showOutput(
                "Skill updates available",
                `${formattedResult}\n\nRun /update-skills --interactive to choose updates.`,
            );
        } else if (ctx.hasUI && notifyWhenCurrent) {
            showOutput("Skill update check", formattedResult);
        }

        return formattedResult;
    }

    // Delegates manifest ref mutation to update-skills.sh --pin via JSON.
    async function pinManifestRefs(updates: SkillUpdate[]) {
        const args = updates.flatMap((update) => ["--pin", `${update.name}=${update.latestRef}`]);
        const result = await runScript(updateScript, ["--json", ...args], 60_000);

        try {
            return {
                ...result,
                pin: JSON.parse(result.output) as SkillPinResult,
            };
        } catch {
            return {
                ...result,
                pin: undefined,
            };
        }
    }

    // Orchestrates interactive update acceptance, pinning, and final skill sync.
    //
    // The flow is intentionally script-driven: check JSON supplies candidate updates,
    // the TUI selects a subset, pin JSON mutates manifest refs, and sync JSON reports
    // final installed skill state.
    async function runInteractiveUpdate(ctx: NotifyContext) {
        const checkResult = await checkSkillUpdates();

        if (!checkResult.check) {
            if (ctx.hasUI) ctx.ui.notify("Skill version check returned invalid JSON", "warning");
            return checkResult.output;
        }

        if (checkResult.code !== 0 || !checkResult.check.ok) {
            if (ctx.hasUI) ctx.ui.notify("Skill version check failed", "warning");
            return formatCheckResult(checkResult.check) || checkResult.output;
        }

        const updates = checkResult.check.updates;
        if (updates.length === 0) {
            return formatCheckResult(checkResult.check);
        }

        const acceptedUpdates = await chooseUpdates(ctx, updates);

        if (acceptedUpdates.length === 0) {
            return `No skill updates selected.\n\nAvailable updates:\n${formatUpdates(updates)}`;
        }

        const pinResult = await pinManifestRefs(acceptedUpdates);
        if (!pinResult.pin) {
            if (ctx.hasUI) ctx.ui.notify("Manifest ref update returned invalid JSON", "warning");
            return pinResult.output;
        }

        if (pinResult.code !== 0 || !pinResult.pin.ok) {
            if (ctx.hasUI) ctx.ui.notify("Manifest ref update failed", "warning");
            return formatFailures(pinResult.pin.failures) || pinResult.output;
        }

        const updateOutput = await updateSkills(ctx, true);
        const manifestOutput = formatUpdates(acceptedUpdates);

        return `Updated manifest refs:\n${manifestOutput}\n\n${updateOutput}`;
    }

    // Runs the sync script in JSON mode and returns concise formatted output.
    async function updateSkills(ctx: NotifyContext, force = true) {
        const args = force ? ["--force"] : [];
        const result = await runScript(updateScript, ["--json", ...args], 120_000);

        let sync: SkillSyncResult | undefined;
        try {
            sync = JSON.parse(result.output) as SkillSyncResult;
        } catch {
            if (ctx.hasUI) ctx.ui.notify("Agent skill update returned invalid JSON", "warning");
            return result.output;
        }

        const formattedResult = formatSyncResult(sync);

        if (result.code === 0 && sync.ok) {
            if (ctx.hasUI && sync.status !== "skipped") {
                ctx.ui.notify("Agent skills updated", "info");
            }
        } else if (ctx.hasUI) {
            ctx.ui.notify("Agent skill update failed. Run ~/.agents/scripts/update-skills.sh --force", "warning");
        }

        return formattedResult;
    }

    // Checks for pinned skill updates at session start, but avoids duplicate checks on reload.
    pi.on("session_start", async (event, ctx) => {
        if (event.reason === "reload") return;
        await checkSkillVersions(ctx);
    });

    // Registers /update-skills for sync, --check, and --interactive workflows.
    pi.registerCommand("update-skills", {
        description: "Update skills; pass --check to check or --interactive to choose version updates",
        handler: async (args, ctx) => {
            const tokens = args.trim().split(/\s+/).filter(Boolean);
            const shouldCheck = tokens.includes("--check") || tokens.includes("-c") || tokens.includes("check");
            const interactive = tokens.includes("--interactive") ||
                tokens.includes("-i") ||
                tokens.includes("interactive");
            const respectInterval = tokens.includes("--respect-interval");

            const output = interactive
                ? await runInteractiveUpdate(ctx)
                : shouldCheck
                    ? await checkSkillVersions(ctx, true)
                    : await updateSkills(ctx, !respectInterval);

            if (!shouldCheck || !ctx.hasUI || interactive) {
                const title = interactive
                    ? "Interactive skill update"
                    : shouldCheck
                        ? "Skill update check"
                        : "Skill update";
                showOutput(title, output);
            }
        },
    });
}
