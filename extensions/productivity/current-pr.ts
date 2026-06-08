import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PR_PARAMS = Type.Object({
	branch: Type.Optional(Type.String({ description: "Optional branch name. Defaults to the current git branch." })),
	includeBody: Type.Optional(Type.Boolean({ description: "Include the PR body in the result. Defaults to false." })),
});

type PrParams = {
	branch?: string;
	includeBody?: boolean;
};

type CommandResult = {
	stdout: string;
	stderr: string;
};

type PrLookup = {
	found: boolean;
	repositoryRoot?: string;
	branch?: string;
	pr?: Record<string, unknown>;
	error?: string;
	stderr?: string;
};

async function run(command: string, args: string[], cwd: string): Promise<CommandResult> {
	const { stdout, stderr } = await execFileAsync(command, args, {
		cwd,
		timeout: 15_000,
		maxBuffer: 8 * 1024 * 1024,
	});

	return {
		stdout: String(stdout).trim(),
		stderr: String(stderr).trim(),
	};
}

async function tryRun(command: string, args: string[], cwd: string): Promise<CommandResult | Error> {
	try {
		return await run(command, args, cwd);
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

function errorText(error: Error): string {
	const maybeProcessError = error as Error & { stderr?: string; stdout?: string; code?: string | number };
	const parts = [maybeProcessError.stderr, maybeProcessError.stdout, error.message]
		.filter((part): part is string => typeof part === "string" && part.trim().length > 0)
		.map((part) => part.trim());
	return parts[0] ?? "Unknown error";
}

function prFields(includeBody: boolean): string {
	const fields = [
		"number",
		"url",
		"title",
		"state",
		"isDraft",
		"author",
		"headRefName",
		"headRepositoryOwner",
		"baseRefName",
		"mergeStateStatus",
		"reviewDecision",
		"statusCheckRollup",
		"labels",
		"assignees",
		"reviewRequests",
		"latestReviews",
		"commits",
		"createdAt",
		"updatedAt",
	];
	if (includeBody) fields.push("body");
	return fields.join(",");
}

function shortName(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && "login" in value && typeof value.login === "string") return value.login;
	if (value && typeof value === "object" && "name" in value && typeof value.name === "string") return value.name;
	return undefined;
}

function listNames(value: unknown): string {
	if (!Array.isArray(value)) return "none";
	const names = value.map(shortName).filter((name): name is string => Boolean(name));
	return names.length > 0 ? names.join(", ") : "none";
}

function statusSummary(pr: Record<string, unknown>): string {
	const checks = pr.statusCheckRollup;
	if (!Array.isArray(checks) || checks.length === 0) return "checks: none";
	const counts = new Map<string, number>();
	for (const check of checks) {
		const status =
			check && typeof check === "object" && "conclusion" in check && typeof check.conclusion === "string"
				? check.conclusion
				: check && typeof check === "object" && "status" in check && typeof check.status === "string"
					? check.status
					: "UNKNOWN";
		counts.set(status, (counts.get(status) ?? 0) + 1);
	}
	return [...counts.entries()].map(([status, count]) => `${status}: ${count}`).join(", ");
}

function formatPr(lookup: PrLookup): string {
	if (!lookup.found || !lookup.pr) {
		const branch = lookup.branch ? ` for branch ${lookup.branch}` : "";
		const reason = lookup.error ? `\nReason: ${lookup.error}` : "";
		return `No GitHub PR found${branch}.${reason}`;
	}

	const pr = lookup.pr;
	const number = pr.number ? `#${String(pr.number)}` : "#?";
	const title = typeof pr.title === "string" ? pr.title : "Untitled PR";
	const state = typeof pr.state === "string" ? pr.state : "unknown";
	const draft = pr.isDraft === true ? " draft" : "";
	const author = shortName(pr.author) ?? "unknown";
	const head = typeof pr.headRefName === "string" ? pr.headRefName : lookup.branch ?? "unknown";
	const base = typeof pr.baseRefName === "string" ? pr.baseRefName : "unknown";
	const url = typeof pr.url === "string" ? pr.url : "";
	const reviewDecision = typeof pr.reviewDecision === "string" ? pr.reviewDecision : "none";
	const mergeState = typeof pr.mergeStateStatus === "string" ? pr.mergeStateStatus : "unknown";

	const lines = [
		`${number}: ${title}`,
		url,
		`state: ${state}${draft}`,
		`branch: ${head} -> ${base}`,
		`author: ${author}`,
		`review: ${reviewDecision}`,
		`merge: ${mergeState}`,
		statusSummary(pr),
		`labels: ${listNames(pr.labels)}`,
		`assignees: ${listNames(pr.assignees)}`,
		`review requests: ${listNames(pr.reviewRequests)}`,
	].filter(Boolean);

	if (typeof pr.body === "string" && pr.body.trim().length > 0) {
		lines.push("", pr.body.trim());
	}

	return lines.join("\n");
}

async function lookupCurrentBranchPr(cwd: string, params: PrParams): Promise<PrLookup> {
	const rootResult = await tryRun("git", ["rev-parse", "--show-toplevel"], cwd);
	if (rootResult instanceof Error) {
		return { found: false, error: `Not inside a git repository: ${errorText(rootResult)}` };
	}

	const repositoryRoot = rootResult.stdout;
	let branch = params.branch?.trim();
	if (!branch) {
		const branchResult = await tryRun("git", ["branch", "--show-current"], repositoryRoot);
		if (branchResult instanceof Error) {
			return { found: false, repositoryRoot, error: `Unable to determine current branch: ${errorText(branchResult)}` };
		}
		branch = branchResult.stdout.trim();
	}

	if (!branch) {
		return { found: false, repositoryRoot, error: "Current checkout is detached and no branch was provided." };
	}

	const args = ["pr", "view", branch, "--json", prFields(params.includeBody === true)];
	const prResult = await tryRun("gh", args, repositoryRoot);
	if (prResult instanceof Error) {
		return { found: false, repositoryRoot, branch, error: errorText(prResult) };
	}

	try {
		return { found: true, repositoryRoot, branch, pr: JSON.parse(prResult.stdout) as Record<string, unknown>, stderr: prResult.stderr };
	} catch (error) {
		return {
			found: false,
			repositoryRoot,
			branch,
			error: `gh returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			stderr: prResult.stderr,
		};
	}
}

export default function currentPrExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "get_current_branch_pr",
		label: "Current Branch PR",
		description: "Find the GitHub pull request associated with the current git branch using gh.",
		promptSnippet: "Find the GitHub pull request for the current git branch without asking the user to paste it.",
		promptGuidelines: [
			"Use get_current_branch_pr when the user asks about the current branch's PR, PR metadata, QA notes, review status, or PR URL.",
			"Do not ask the user to provide the PR URL before trying get_current_branch_pr in a git repository.",
		],
		parameters: PR_PARAMS,
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Looking up the GitHub PR for this branch..." }], details: {} });
			const lookup = await lookupCurrentBranchPr(ctx.cwd, params as PrParams);
			return {
				content: [{ type: "text", text: formatPr(lookup) }],
				details: lookup,
				isError: false,
			};
		},
	});

	pi.registerCommand("pr", {
		description: "Show the GitHub PR associated with the current branch.",
		handler: async (_args, ctx) => {
			const lookup = await lookupCurrentBranchPr(ctx.cwd, {});
			pi.sendMessage({
				customType: "pr",
				content: formatPr(lookup),
				display: true,
				details: lookup,
			});
		},
	});
}
