import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { loadSkillEvalConfig, SkillEvalConfigError } from "./config.ts";
import { SkillEvalMonitor } from "./monitor.ts";
import { resolveCommandPath } from "./paths.ts";
import { recentReviewRuns, resolveReviewRun, reviewerSkillPrompt, SkillEvalReviewError } from "./review.ts";
import { runEvaluation, type EvaluationRunResult } from "./runner.ts";

const commandName = "skill-eval";

function usage(): string {
	return `Usage:\n  /${commandName} validate <eval.yaml>\n  /${commandName} run <eval.yaml>\n  /${commandName} review <run-id|path|latest>`;
}

function errorMessage(error: unknown): string {
	return error instanceof SkillEvalConfigError
		? error.issues.map((issue) => `- ${issue}`).join("\n")
		: error instanceof Error ? error.message : String(error);
}

export default function skillEvalExtension(pi: ExtensionAPI) {
	pi.registerCommand(commandName, {
		description: "Validate, run, or review a skill evaluation",
		getArgumentCompletions: (prefix) => {
			const values = [
				{ value: "validate", label: "validate", description: "Validate an eval YAML file" },
				{ value: "run", label: "run", description: "Run an eval with a full-screen monitor" },
				{ value: "review", label: "review", description: "Review retained evidence with the reviewer skill" },
			];
			const input = prefix.trim();
			return values.filter((item) => item.value.startsWith(input)).length > 0
				? values.filter((item) => item.value.startsWith(input))
				: null;
		},
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input || input === "--help" || input === "-h" || input === "help") {
				ctx.ui.notify(usage(), "info");
				return;
			}

			const match = input.match(/^(validate|run|review)(?:\s+(.+))?$/);
			if (!match) {
				ctx.ui.notify(`Unknown skill-eval command.\n\n${usage()}`, "error");
				return;
			}
			const operation = match[1] as "validate" | "run" | "review";
			if (!match[2]?.trim()) {
				if (operation === "review") {
					const recent = await recentReviewRuns();
					const hint = recent.length > 0
						? `\n\nRecent runs:\n${recent.map((run) => `  ${run.id} (${run.status})`).join("\n")}`
						: "";
					ctx.ui.notify(`Missing retained run ID, path, or \`latest\`.${hint}\n\n${usage()}`, "error");
				} else {
					ctx.ui.notify(`Missing eval YAML path.\n\n${usage()}`, "error");
				}
				return;
			}

			if (operation === "review") {
				if (!ctx.isIdle()) {
					ctx.ui.notify(`/${commandName} review requires the current agent to be idle.`, "error");
					return;
				}
				try {
					const selected = await resolveReviewRun(match[2], { cwd: ctx.cwd });
					ctx.ui.notify(`Starting semantic review of ${selected.record.runId}\nRun: ${selected.runDir}`, "info");
					pi.sendUserMessage(reviewerSkillPrompt(selected.runDir), { expandPromptTemplates: true });
				} catch (error) {
					const message = error instanceof SkillEvalReviewError ? error.message : errorMessage(error);
					ctx.ui.notify(`Cannot review skill eval:\n${message}`, "error");
				}
				return;
			}

			const configPath = resolveCommandPath(match[2], ctx.cwd);
			let resolved;
			try {
				resolved = await loadSkillEvalConfig(configPath);
			} catch (error) {
				ctx.ui.notify(`Invalid skill eval:\n${errorMessage(error)}`, "error");
				return;
			}

			if (operation === "validate") {
				ctx.ui.notify([
					`Valid skill eval: ${resolved.config.name}`,
					`Workspace: ${resolved.workspacePath}`,
					`Model: ${resolved.config.agent.model}`,
					`Variants: ${Object.keys(resolved.config.variants).length}`,
					`Replacement sources: ${resolved.replacements.length}`,
					`Removal targets: ${resolved.removals.length}`,
					`Review rubric: ${resolved.reviewRubric?.rubricPath ?? "not provided (reviewer will infer with lower confidence)"}`,
					`Timeout: ${resolved.config.limits.timeoutSeconds}s active execution`,
					`On timeout: ${resolved.config.limits.onTimeout}${resolved.config.limits.onTimeout === "retry" ? ` (up to ${resolved.config.limits.maxRetries} retries)` : ""}`,
					`Dialogs: ${resolved.config.dialogs}`,
				].join("\n"), "info");
				return;
			}

			if (ctx.mode !== "tui") {
				ctx.ui.notify(`/${commandName} run requires interactive TUI mode.`, "error");
				return;
			}

			const abortController = new AbortController();
			let result: EvaluationRunResult | undefined;
			await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
				const monitor = new SkillEvalMonitor(
					resolved.config,
					tui,
					theme,
					keybindings,
					() => abortController.abort(new Error("Evaluation cancelled by user")),
					() => done(),
				);
				// Deferring starts the runner only after the monitor has been returned to Pi and can receive events.
				queueMicrotask(() => {
					void runEvaluation(resolved, {
						parentUI: ctx.ui,
						signal: abortController.signal,
						onEvent: (event) => monitor.onEvent(event),
					}).then((value) => {
						result = value;
						monitor.finish(value);
					}).catch((error) => monitor.fail(error));
				});
				return monitor;
			}, {
				overlay: true,
				overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center", margin: 0 },
			});

			if (result) {
				const record = result.storage.record;
				const details = [
					`Skill eval ${result.status}: ${record.name}`,
					`Run: ${result.storage.runDir}`,
				];
				if (result.status !== "completed") {
					details.push(`Failure phase: ${record.failurePhase ?? "unavailable"}`);
					const variantError = record.variants.find((variant) => variant.error)?.error;
					if (record.error ?? variantError) details.push(`Error: ${record.error ?? variantError}`);
					details.push(`Failure evidence: ${path.join(result.storage.runDir, "failure.json")}`);
				}
				if (record.artifacts.reportMarkdown.completeness === "complete") {
					details.push(`Markdown: ${path.join(result.storage.runDir, "report.md")}`);
				}
				if (record.artifacts.reportHtml.completeness === "complete") {
					details.push(`HTML: ${path.join(result.storage.runDir, "report.html")}`);
				}
				if (result.status === "completed") {
					details.push(`Review: /${commandName} review ${record.runId}`);
				}
				ctx.ui.notify(details.join("\n"), result.status === "completed" ? "info" : "warning");
			}
		},
	});
}
