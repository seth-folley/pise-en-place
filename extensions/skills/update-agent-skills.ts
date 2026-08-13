/*
 * Pi extension for shared agent skill updates.
 *
 * The extension owns manifest-based version checks so startup checks do not
 * depend on ~/.agents/scripts/check-skill-updates.sh. Syncing and pinning remain
 * delegated to update-skills.sh because they own installation, post-processing,
 * locking, and manifest mutation.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { askMultiSelectQuestion } from "../../src/shared/interactive-questions.ts";

const agentsHome = join(homedir(), ".agents");
const skillsDirectory = process.env.AGENTS_SKILLS_DIR ?? join(agentsHome, "skills");
const manifestPath = process.env.AGENTS_SKILLS_MANIFEST ?? join(skillsDirectory, "manifest.json");
const updateScript = join(agentsHome, "scripts", "update-skills.sh");
const checkTimeoutMs = 10_000;
const messageType = "agent-skills-output";
const versionPattern = /^v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/;

type NotifyLevel = "info" | "warning" | "error";
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
    manifestPath: string;
    updates: SkillUpdate[];
    skipped: Array<{ name: string; reason: string }>;
    failures: Array<{ name?: string; message: string }>;
};

type SkillManifestEntry = {
    name?: unknown;
    source?: unknown;
    ref?: unknown;
    enabled?: unknown;
};

type SkillManifest = {
    skills?: unknown;
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

    // Reads the local manifest and checks each version-pinned source directly.
    // A timeout per remote prevents a weak connection from delaying session start.
    async function checkSkillUpdates(): Promise<SkillCheckResult> {
        let manifest: SkillManifest;
        try {
            manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SkillManifest;
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return {
                ok: false,
                manifestPath,
                updates: [],
                skipped: [],
                failures: [{ message: `Failed to read skills manifest: ${reason}` }],
            };
        }

        if (!Array.isArray(manifest.skills)) {
            return {
                ok: false,
                manifestPath,
                updates: [],
                skipped: [],
                failures: [{ message: "Skills manifest must contain a skills array." }],
            };
        }

        const updates: SkillUpdate[] = [];
        const skipped: SkillCheckResult["skipped"] = [];
        const failures: SkillCheckResult["failures"] = [];

        await Promise.all(manifest.skills.map(async (entry, index) => {
            const skill = entry && typeof entry === "object" ? entry as SkillManifestEntry : {};
            const name = typeof skill.name === "string" && skill.name ? skill.name : `<skill #${index + 1}>`;
            if (skill.enabled === false) {
                skipped.push({ name, reason: "skill is disabled" });
                return;
            }
            if (typeof skill.name !== "string" || !skill.name) {
                skipped.push({ name, reason: "missing name" });
                return;
            }
            if (typeof skill.source !== "string" || !skill.source) {
                skipped.push({ name, reason: "missing source" });
                return;
            }
            if (typeof skill.ref !== "string" || !skill.ref) {
                skipped.push({ name, reason: "missing ref" });
                return;
            }
            if (!versionPattern.test(skill.ref)) {
                skipped.push({ name, reason: "ref is not version-like" });
                return;
            }

            let result: Awaited<ReturnType<typeof pi.exec>>;
            try {
                result = await pi.exec("git", ["ls-remote", "--tags", "--refs", skill.source], {
                    timeout: checkTimeoutMs,
                });
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                failures.push({ name, message: `Unable to check ${name}: ${reason}` });
                return;
            }

            const tags = result.stdout.split("\n")
                .map((line) => line.trim().split(/\s+/)[1]?.replace("refs/tags/", ""))
                .filter((tag): tag is string => Boolean(tag && versionPattern.test(tag)))
                .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

            if (result.code !== 0 || tags.length === 0) {
                const detail = result.killed
                    ? `timed out after ${checkTimeoutMs / 1_000} seconds`
                    : result.stderr.trim();
                failures.push({
                    name,
                    message: `Unable to find version tags for ${name}${detail ? `: ${detail}` : "."}`,
                });
                return;
            }

            const latestRef = tags.at(-1)!;
            if (latestRef === skill.ref) return;

            const update: SkillUpdate = {
                name,
                source: skill.source,
                currentRef: skill.ref,
                latestRef,
            };
            const githubMatch = skill.source.replace(/\.git$/, "").match(/^https:\/\/github\.com\/([^/]+\/[^/]+)$/);
            if (githubMatch) {
                const repository = `https://github.com/${githubMatch[1]}`;
                update.diffURL = `${repository}/compare/${skill.ref}...${latestRef}`;
                update.changelogURL = `${repository}/releases/tag/${latestRef}`;
            }
            updates.push(update);
        }));

        return { ok: failures.length === 0, manifestPath, updates, skipped, failures };
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
        return askMultiSelectQuestion<SkillUpdate>(ctx, {
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
        const check = await checkSkillUpdates();
        const formattedResult = formatCheckResult(check);

        if (!check.ok) {
            if (ctx.hasUI) ctx.ui.notify("Skill version check failed", "warning");
            return formattedResult;
        }

        if (ctx.hasUI && check.updates.length > 0) {
            ctx.ui.notify(
                `Skill updates available: ${check.updates.length}. Run /update-skills --interactive.`,
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
    // The extension check supplies candidate updates; the TUI selects a subset,
    // then the sync script pins refs and reports the final installed skill state.
    async function runInteractiveUpdate(ctx: NotifyContext) {
        const check = await checkSkillUpdates();

        if (!check.ok) {
            if (ctx.hasUI) ctx.ui.notify("Skill version check failed", "warning");
            return formatCheckResult(check);
        }

        const updates = check.updates;
        if (updates.length === 0) {
            return formatCheckResult(check);
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
