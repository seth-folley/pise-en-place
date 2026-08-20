import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { askQuestionnaire } from "../../src/shared/interactive-questions.ts";

const execFileAsync = promisify(execFile);
const jiraKeyPattern = /^[A-Z][A-Z0-9]+-\d+$/i;

type CommandResult = { stdout: string; stderr: string };

type JiraStory = {
	key: string;
	title: string;
	description?: string;
	status?: string;
	issueType?: string;
	priority?: string;
	labels: string[];
	components: string[];
	linkedIssues: string[];
};

async function run(command: string, args: string[], cwd: string): Promise<CommandResult> {
	const { stdout, stderr } = await execFileAsync(command, args, {
		cwd,
		timeout: 30_000,
		maxBuffer: 8 * 1024 * 1024,
	});
	return { stdout: String(stdout).trim(), stderr: String(stderr).trim() };
}

function commandError(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const processError = error as Error & { stderr?: string; stdout?: string };
	return [processError.stderr, processError.stdout, error.message]
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		.map((value) => value.trim())
		.at(0) ?? "Unknown command error";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
	if (typeof value === "string") return value.trim() || undefined;
	if (typeof value === "number") return String(value);
	if (Array.isArray(value)) {
		const values = value.map(text).filter((item): item is string => Boolean(item));
		return values.length > 0 ? values.join(", ") : undefined;
	}
	const object = asRecord(value);
	if (!object) return undefined;
	for (const key of ["text", "value", "name", "displayName", "content"]) {
		const result = text(object[key]);
		if (result) return result;
	}
	return undefined;
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map(text).filter((item): item is string => Boolean(item));
}

function linkedIssues(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((link) => {
		const item = asRecord(link);
		if (!item) return [];
		const linked = asRecord(item.outwardIssue) ?? asRecord(item.inwardIssue);
		if (!linked) return [];
		const key = text(linked.key);
		const fields = asRecord(linked.fields);
		const summary = text(fields?.summary);
		return key ? [summary ? `${key}: ${summary}` : key] : [];
	});
}

function parseStory(raw: string, requestedKey: string): JiraStory {
	let decoded: unknown;
	try {
		decoded = JSON.parse(raw);
	} catch {
		throw new Error("acli returned invalid JSON for this work item.");
	}
	const root = asRecord(decoded);
	const fields = asRecord(root?.fields) ?? root;
	if (!fields) throw new Error("acli returned an unexpected work-item response.");
	const title = text(fields.summary);
	if (!title) throw new Error("The Jira work item has no summary.");
	return {
		key: text(root?.key) ?? requestedKey.toUpperCase(),
		title,
		description: text(fields.description),
		status: text(fields.status),
		issueType: text(fields.issuetype),
		priority: text(fields.priority),
		labels: stringList(fields.labels),
		components: stringList(fields.components),
		linkedIssues: linkedIssues(fields.issuelinks),
	};
}

function branchTypeFor(issueType: string | undefined): string {
	switch (issueType?.trim().toLowerCase()) {
		case "story": return "feature";
		case "bug": return "fix";
		case "task": return "task";
		case "spike": return "spike";
		default: return "chore";
	}
}

function validSlug(value: string): boolean {
	return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 48;
}

function slugPrompt(story: JiraStory): string {
	return [
		"Suggest exactly three concise git branch slugs for the Jira work item below.",
		"Return only a JSON array of three strings. Do not use Markdown or commentary.",
		"Rules:",
		"- lowercase letters and numbers joined by single hyphens",
		"- at most 48 characters each; shorter is better",
		"- use an imperative phrase",
		"- preserve meaningful product, API, skill, and architecture terms",
		"- do not include a username, branch type, or Jira key",
		`Jira key: ${story.key}`,
		`Work-item type: ${story.issueType ?? "unknown"}`,
		`Title: ${story.title}`,
		story.description ? `Description: ${story.description}` : undefined,
		story.components.length > 0 ? `Components: ${story.components.join(", ")}` : undefined,
	].filter((line): line is string => Boolean(line)).join("\n");
}

function parseSlugSuggestions(raw: string): string[] {
	const candidate = raw
		.replace(/\u001B\[[0-9;]*m/g, "")
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	let decoded: unknown;
	try {
		decoded = JSON.parse(candidate);
	} catch {
		throw new Error("The model did not return valid slug suggestions.");
	}
	if (!Array.isArray(decoded)) throw new Error("The model did not return a slug list.");
	const suggestions = [...new Set(decoded.filter((value): value is string => typeof value === "string").map((value) => value.trim()))]
		.filter(validSlug)
		.slice(0, 3);
	if (suggestions.length === 0) throw new Error("The model returned no valid slug suggestions.");
	return suggestions;
}

function worktreeProposal(story: JiraStory, branchType: string, slugName: string): { branch: string; folder: string } {
	const folder = `${story.key.toLowerCase()}-${slugName}`;
	return { branch: `sf/${branchType}/${story.key}/${slugName}`, folder };
}

function storyContext(story: JiraStory): string {
	const lines = [
		`# Jira ${story.key}: ${story.title}`,
		story.issueType ? `Type: ${story.issueType}` : undefined,
		story.status ? `Status: ${story.status}` : undefined,
		story.priority ? `Priority: ${story.priority}` : undefined,
		story.labels.length > 0 ? `Labels: ${story.labels.join(", ")}` : undefined,
		story.components.length > 0 ? `Components: ${story.components.join(", ")}` : undefined,
		story.description ? `\n## Description\n${story.description}` : undefined,
		story.linkedIssues.length > 0 ? `\n## Linked work items\n${story.linkedIssues.map((issue) => `- ${issue}`).join("\n")}` : undefined,
		"\nUse this ticket as task context. Inspect the repository before making changes, and ask clarifying questions when the ticket does not establish the intended behavior.",
	].filter((line): line is string => Boolean(line));
	return lines.join("\n");
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function gitRoot(cwd: string): Promise<string> {
	return (await run("git", ["rev-parse", "--show-toplevel"], cwd)).stdout;
}

async function createSupacodeWorktree(cwd: string, root: string, proposal: { branch: string; folder: string }): Promise<string> {
	const repoID = encodeURIComponent(root);
	const result = await run(
		"supacode",
		["repo", "worktree-new", "-r", repoID, "--branch", proposal.branch, "--name", proposal.folder],
		cwd,
	);
	if (!result.stdout) throw new Error("Supacode did not return the new worktree ID.");
	return result.stdout.split(/\s+/)[0];
}

async function startPiInWorktree(cwd: string, worktreeID: string, story: JiraStory): Promise<void> {
	const prompt = storyContext(story);
	const sessionName = `${story.key}: ${story.title}`.slice(0, 120);
	const command = `pi --name ${shellQuote(sessionName)} ${shellQuote(prompt)}`;
	await run("supacode", ["tab", "new", "-w", worktreeID, "-i", command], cwd);
}

export default function jiraWorktreeExtension(pi: ExtensionAPI) {
	pi.registerCommand("jira-worktree", {
		description: "Load a Jira story, select an agent-suggested or custom branch slug, and create a Supacode worktree.",
		handler: async (args, ctx) => {
			const key = args.trim().toUpperCase();
			if (!jiraKeyPattern.test(key)) {
				ctx.ui.notify("Usage: /jira-worktree <JIRA-KEY> (for example, /jira-worktree IOSDOX-27280)", "error");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("/jira-worktree requires interactive UI so it can confirm the branch before creation.", "error");
				return;
			}

			let story: JiraStory;
			let root: string;
			try {
				const [workItem, repositoryRoot] = await Promise.all([
					run("acli", ["jira", "workitem", "view", key, "--json", "--fields", "key,issuetype,summary,status,assignee,description,priority,labels,components,issuelinks"], ctx.cwd),
					gitRoot(ctx.cwd),
				]);
				story = parseStory(workItem.stdout, key);
				root = repositoryRoot;
			} catch (error) {
				ctx.ui.notify(`Unable to read ${key}: ${commandError(error)}`, "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model is selected for branch slug suggestions.", "error");
				return;
			}

			let suggestions: string[];
			try {
				ctx.ui.notify(`Generating concise branch names for ${story.key}...`, "info");
				const result = await pi.exec(
					"pi",
					[
						"--print",
						"--no-session",
						"--no-extensions",
						"--no-skills",
						"--no-prompt-templates",
						"--no-themes",
						"--no-context-files",
						"--no-tools",
						"--provider",
						ctx.model.provider,
						"--model",
						ctx.model.id,
						[
							"You name git branches. Follow the requested output format exactly.",
							"Do not investigate the repository or request more context.",
							"You have no tools and must answer only from the supplied Jira context.",
							"",
							slugPrompt(story),
						].join("\n"),
					],
					{ cwd: ctx.cwd, timeout: 60_000 },
				);
				if (result.code !== 0) {
					throw new Error(result.stderr?.trim() || result.stdout?.trim() || "The isolated naming agent failed.");
				}
				suggestions = parseSlugSuggestions(result.stdout ?? "");
			} catch (error) {
				ctx.ui.notify(`Unable to generate branch names: ${commandError(error)}`, "error");
				return;
			}

			const branchType = branchTypeFor(story.issueType);
			const answers = await askQuestionnaire<string>(ctx, {
				title: `Branch name for ${story.key}`,
				questions: [{
					id: "slug",
					label: "Branch",
					question: `Choose the slug for sf/${branchType}/${story.key}/`,
					multiple: false,
					allowOther: true,
					otherLabel: "Custom slug…",
					options: suggestions.map((suggestion, index) => ({
						label: suggestion,
						value: suggestion,
						selected: index === 0,
					})),
				}],
			});
			const slugName = String(answers[0]?.selected[0] ?? "").trim();
			if (!slugName) return;
			if (!validSlug(slugName)) {
				ctx.ui.notify("Slug must use lowercase letters, numbers, and single hyphens only, and be at most 48 characters.", "error");
				return;
			}

			const proposal = worktreeProposal(story, branchType, slugName);
			try {
				const worktreeID = await createSupacodeWorktree(ctx.cwd, root, proposal);
				await startPiInWorktree(ctx.cwd, worktreeID, story);
				ctx.ui.notify(`Created ${proposal.branch} and opened a new Pi session for ${story.key}.`, "info");
			} catch (error) {
				ctx.ui.notify(`Could not create the Supacode worktree: ${commandError(error)}`, "error");
			}
		},
	});
}
