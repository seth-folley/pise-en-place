import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text } from "@earendil-works/pi-tui";
import { fileURLToPath } from "node:url";
import { parseImproveSkillArguments, readCustomPrompt, skillReviewHelpText } from "./arguments.ts";
import { buildConsolidationCommand, buildLaunchPlans, safeTabTitle } from "./launcher.ts";
import { buildReviewPrompt, formatReviewPrompts, type Reviewer } from "./prompt.ts";
import { resolveSkill } from "./resolver.ts";
import { createSkillReviewRun, recordReviewerLaunchFailure, recordRunLaunchFailure, writeSkillReviewPrompts } from "./run.ts";
import { registerSkillReviewPromptTool } from "./tool.ts";

const reviewRunnerPath = fileURLToPath(new URL("./review-runner.mjs", import.meta.url));

const controlTimeoutMs = 15_000;
const requiredSupacodeEnvironment = [
	"SUPACODE_WORKTREE_ID",
	"SUPACODE_TAB_ID",
	"SUPACODE_SURFACE_ID",
	"SUPACODE_SOCKET_PATH",
] as const;

type CommandResult = { code: number; stdout: string; stderr: string; killed?: boolean };
type CommandRunner = (command: string, commandArgs: string[]) => Promise<CommandResult>;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function output(result: CommandResult): string {
	return [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
}

function resourceID(result: CommandResult, action: string): string {
	if (result.code !== 0) throw new Error(`${action} failed: ${output(result) || `exit ${result.code}`}`);
	const id = result.stdout.trim().split(/\s+/)[0];
	if (!id) throw new Error(`${action} did not return an ID.`);
	return id;
}

/** Verifies the current Supacode worktree and reviewer executables before launch. */
export async function verifyReviewPrerequisites(run: CommandRunner, worktreeID: string): Promise<void> {
	const [worktreeResult, ...executables] = await Promise.all([
		run("supacode", ["worktree", "status", "-w", worktreeID]),
		...(["pi", "codex", "claude"] as const).map((command) => run(command, ["--version"])),
	]);
	if (worktreeResult.code !== 0) throw new Error(`Current Supacode worktree is unavailable: ${output(worktreeResult)}`);
	for (const [index, result] of executables.entries()) {
		if (result.code !== 0) throw new Error(`Required executable is unavailable: ${["pi", "codex", "claude"][index]} (${output(result) || `exit ${result.code}`})`);
	}
}

async function showPromptPreview(ctx: ExtensionCommandContext, title: string, prompt: string) {
	await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
		const heading = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
		const body = new Text(prompt, 1, 1);
		const hint = new Text(theme.fg("dim", "Enter or Esc to close"), 1, 0);
		return {
			render: (width) => [...heading.render(width), ...body.render(width), ...hint.render(width)],
			handleInput: (data) => {
				if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) done();
			},
			invalidate: () => {
				heading.invalidate();
				body.invalidate();
				hint.invalidate();
			},
		};
	});
}

export default function improveSkillExtension(pi: ExtensionAPI) {
	registerSkillReviewPromptTool(pi);
	pi.registerCommand("skill-review", {
		description: "Open independent read-only Pi, Codex, and Claude reviews for a skill",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify("/skill-review requires Pi's interactive TUI.", "error");
				return;
			}

			let parsed: ReturnType<typeof parseImproveSkillArguments>;
			try {
				parsed = parseImproveSkillArguments(args);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				return;
			}
			if (parsed.help) {
				ctx.ui.notify(skillReviewHelpText(), "info");
				return;
			}

			const run = async (command: string, commandArgs: string[], timeout = controlTimeoutMs) => {
				const result = await pi.exec(command, commandArgs, { cwd: ctx.cwd, timeout });
				return result as CommandResult;
			};

			let repositoryRoot: string;
			try {
				const gitResult = await run("git", ["rev-parse", "--show-toplevel"]);
				if (gitResult.code !== 0) throw new Error(output(gitResult) || `exit ${gitResult.code}`);
				repositoryRoot = gitResult.stdout.trim();
				if (!repositoryRoot) throw new Error("empty repository root");
			} catch (error) {
				ctx.ui.notify(`Unable to find the Git repository root: ${errorMessage(error)}`, "error");
				return;
			}

			let skill: Awaited<ReturnType<typeof resolveSkill>>;
			try {
				skill = await resolveSkill(parsed.skillArgument, repositoryRoot);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				return;
			}

			let customPrompt: string | undefined;
			let customPromptPath: string | undefined;
			try {
				if (parsed.promptPath) {
					const loaded = await readCustomPrompt(parsed.promptPath, ctx.cwd);
					customPrompt = loaded.content;
					customPromptPath = loaded.path;
				}
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				return;
			}

			const promptOptions = { customPrompt, focus: parsed.focus };
			if (parsed.showPrompt) {
				await showPromptPreview(ctx, `Review prompts for ${skill.name}`, formatReviewPrompts(skill, promptOptions));
				return;
			}

			const missingEnvironment = requiredSupacodeEnvironment.filter((key) => !process.env[key]);
			if (missingEnvironment.length > 0) {
				ctx.ui.notify(`/skill-review must run inside Supacode (missing ${missingEnvironment.join(", ")}).`, "error");
				return;
			}

			const worktreeID = process.env.SUPACODE_WORKTREE_ID!;
			try {
				await verifyReviewPrerequisites(run, worktreeID);
			} catch (error) {
				ctx.ui.notify(`Unable to start skill reviews: ${errorMessage(error)}`, "error");
				return;
			}

			const prompts = Object.fromEntries(((["Pi", "Codex", "Claude"] as Reviewer[]).map((reviewer) => [
				reviewer,
				buildReviewPrompt(reviewer, skill, promptOptions),
			]))) as Record<Reviewer, string>;

			let reviewRun: Awaited<ReturnType<typeof createSkillReviewRun>>;
			try {
				reviewRun = await createSkillReviewRun(skill, repositoryRoot, {
					...(parsed.focus ? { focus: parsed.focus } : {}),
					...(customPromptPath ? { customPromptPath } : {}),
				});
				await writeSkillReviewPrompts(reviewRun.runDir, prompts);
			} catch (error) {
				ctx.ui.notify(`Unable to create skill review storage: ${errorMessage(error)}`, "error");
				return;
			}

			const { runDir, record } = reviewRun;
			const plans = buildLaunchPlans(repositoryRoot, skill.directory, runDir, reviewRunnerPath, skill.name, {
				Pi: record.reviewers.Pi.sessionId,
				Codex: record.reviewers.Codex.sessionId,
				Claude: record.reviewers.Claude.sessionId,
			});
			ctx.ui.notify(`Starting independent Pi, Codex, and Claude reviews of ${skill.name}…\nRun: ${runDir}`, "info");

			let tabID: string | undefined;
			let reviewerStarted = false;
			const launchFailures: Reviewer[] = [];
			try {
				tabID = resourceID(await run("supacode", ["tab", "new", "-w", worktreeID, "--title", safeTabTitle(skill.name)]), "Creating review tab");
				const codexSurfaceID = resourceID(await run("supacode", ["surface", "split", "-w", worktreeID, "-t", tabID, "-s", tabID, "-d", "vertical"]), "Creating Codex surface");
				const claudeSurfaceID = resourceID(await run("supacode", ["surface", "split", "-w", worktreeID, "-t", tabID, "-s", tabID, "-d", "horizontal"]), "Creating Claude surface");
				const consolidatedSurfaceID = resourceID(await run("supacode", ["surface", "split", "-w", worktreeID, "-t", tabID, "-s", codexSurfaceID, "-d", "horizontal"]), "Creating consolidated surface");

				const surfaceIDs = [tabID, codexSurfaceID, claudeSurfaceID];
				for (const [index, plan] of plans.entries()) {
					const launch = await run("supacode", ["surface", "focus", "-w", worktreeID, "-t", tabID, "-s", surfaceIDs[index], "-i", plan.command]);
					if (launch.code !== 0) {
						const message = `Starting ${plan.reviewer} failed: ${output(launch) || `exit ${launch.code}`}`;
						await recordReviewerLaunchFailure(runDir, plan.reviewer, message);
						launchFailures.push(plan.reviewer);
						continue;
					}
					reviewerStarted = true;
				}
				const consolidation = await run("supacode", ["surface", "focus", "-w", worktreeID, "-t", tabID, "-s", consolidatedSurfaceID, "-i", buildConsolidationCommand(reviewRunnerPath, runDir)]);
				if (consolidation.code !== 0) throw new Error(`Starting consolidation failed: ${output(consolidation) || `exit ${consolidation.code}`}`);
				const focus = await run("supacode", ["surface", "focus", "-w", worktreeID, "-t", tabID, "-s", tabID]);
				if (focus.code !== 0) ctx.ui.notify(`Reviews started, but Pi's review pane could not be focused: ${output(focus) || `exit ${focus.code}`}`, "warning");
			} catch (error) {
				const launchError = errorMessage(error);
				try {
					await recordRunLaunchFailure(runDir, launchError);
				} catch {
					// Keep the original launch error as the primary diagnostic.
				}
				if (tabID && !reviewerStarted) {
					try {
						await run("supacode", ["tab", "close", "-w", worktreeID, "-t", tabID, "--background"]);
					} catch {
						// Preserve the original failure; a failed best-effort rollback is visible in Supacode.
					}
					ctx.ui.notify(`Unable to create skill review tab: ${errorMessage(error)}\nRun: ${runDir}`, "error");
				} else if (tabID) {
					ctx.ui.notify(`Skill review tab may contain partial results: ${errorMessage(error)}\nRun: ${runDir}`, "error");
				} else {
					ctx.ui.notify(`Unable to create skill review tab: ${errorMessage(error)}\nRun: ${runDir}`, "error");
				}
				return;
			}

			const promptNote = customPromptPath ? ` Custom prompt: ${customPromptPath}.` : "";
			const launchNote = launchFailures.length > 0 ? ` Failed to launch: ${launchFailures.join(", ")}.` : "";
			ctx.ui.notify(`Opened retained reviews and automatic consolidation for ${skill.name}. Resolved: ${skill.directory}.${promptNote}${launchNote}\nRun: ${runDir}`, launchFailures.length > 0 ? "warning" : "info");
		},
	});
}
