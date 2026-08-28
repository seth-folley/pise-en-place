import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { failureHints, failureSummary } from "./failure.ts";
import type { RunRecord, VariantRecord } from "./types.ts";

interface ToolTimelineItem {
	name: string;
	startedAt: string;
	completedAt?: string;
	isError?: boolean;
}

async function readOptional(file: string): Promise<string> {
	try { return await readFile(file, "utf8"); } catch { return ""; }
}

async function toolTimeline(runDir: string, variant: VariantRecord): Promise<ToolTimelineItem[]> {
	const source = await readOptional(path.join(runDir, variant.artifacts.toolCalls.path));
	const calls = new Map<string, ToolTimelineItem>();
	for (const line of source.split("\n")) {
		if (!line) continue;
		try {
			const row = JSON.parse(line) as { timestamp: string; event: Record<string, unknown> };
			const id = String(row.event.toolCallId ?? "");
			if (row.event.type === "tool_execution_start") calls.set(id, { name: String(row.event.toolName), startedAt: row.timestamp });
			if (row.event.type === "tool_execution_end") {
				const call = calls.get(id) ?? { name: String(row.event.toolName), startedAt: row.timestamp };
				call.completedAt = row.timestamp;
				call.isError = row.event.isError === true;
				calls.set(id, call);
			}
		} catch { /* Partial final lines remain inspectable in the canonical JSONL. */ }
	}
	return [...calls.values()];
}

function seconds(ms: number): string {
	return `${(ms / 1000).toFixed(2)}s`;
}

function markdownLink(label: string, target: string): string {
	return `[${label}](${target.split(path.sep).join("/")})`;
}

async function markdownReport(runDir: string, run: RunRecord): Promise<string> {
	const lines = [
		`# Skill evaluation: ${run.name}`,
		"",
		`- **Run ID:** \`${run.runId}\``,
		`- **Operational status:** \`${run.status}\``,
		`- **Created:** ${run.createdAt}`,
		`- **Completed:** ${run.completedAt ?? "not completed"}`,
		`- **Baseline:** \`${run.baselineSha ?? "unavailable"}\``,
		"",
		"> Operational status is not a semantic pass/fail judgment.",
	];
	if (run.status !== "completed") {
		lines.push(
			"",
			"## Failure diagnosis",
			"",
			`- **Summary:** ${failureSummary(run)}`,
			`- **Failure phase:** \`${run.failurePhase ?? "unavailable"}\``,
			`- **Structured evidence:** ${run.artifacts.failure ? markdownLink("failure.json", run.artifacts.failure.path) : "unavailable"}`,
			"",
			"### Diagnostic hints",
			"",
			...failureHints(run).map((hint) => `- ${hint}`),
		);
	}
	lines.push(
		"",
		"## Variants",
		"",
		"| Variant | Status | Active | Wall | Cost | Tools | Changes |",
		"| --- | --- | ---: | ---: | ---: | ---: | ---: |",
	);
	for (const variant of run.variants) {
		const metrics = variant.metrics;
		lines.push(`| ${variant.id} | \`${variant.status}\` | ${metrics ? seconds(metrics.activeTimeMs) : "—"} | ${metrics ? seconds(metrics.wallTimeMs) : "—"} | ${metrics ? metrics.cost : "—"} | ${metrics?.toolCalls ?? "—"} | ${metrics ? `${metrics.changedFiles} (+${metrics.insertions}/-${metrics.deletions})` : "—"} |`);
	}

	for (const variant of run.variants) {
		lines.push("", `## ${variant.id}`, "", `**Status:** \`${variant.status}\``);
		if (variant.failurePhase) lines.push("", `**Failure phase:** \`${variant.failurePhase}\``);
		lines.push("", "### Prompt", "", variant.prompt);
		if (variant.error) lines.push("", "### Operational details", "", "```text", variant.error, "```");
		if (variant.policyFindings.length > 0) {
			lines.push("", "### Policy findings", "", ...variant.policyFindings.map((finding) => `- **${finding.type}:** ${finding.detail}`));
		}
		const finalResponse = await readOptional(path.join(runDir, variant.artifacts.finalResponse.path));
		lines.push("", "### Final response", "", finalResponse || "_Unavailable._");
		const timeline = await toolTimeline(runDir, variant);
		lines.push("", "### Tool timeline", "");
		if (timeline.length === 0) lines.push("_No recorded tool calls._");
		else {
			lines.push("| Tool | Outcome | Duration |", "| --- | --- | ---: |");
			for (const call of timeline) {
				const duration = call.completedAt ? seconds(Date.parse(call.completedAt) - Date.parse(call.startedAt)) : "incomplete";
				lines.push(`| \`${call.name}\` | ${call.completedAt ? (call.isError ? "error" : "completed") : "incomplete"} | ${duration} |`);
			}
		}
		const links = Object.entries(variant.artifacts)
			.filter(([, reference]) => reference.completeness !== "not_started")
			.map(([name, reference]) => reference.completeness === "unavailable"
				? `${name}: unavailable`
				: `${markdownLink(name, reference.path)} (${reference.completeness})`);
		lines.push("", "### Complete evidence", "", links.length ? links.map((link) => `- ${link}`).join("\n") : "_No artifacts available._");
	}
	if (run.error) lines.push("", "## Run error", "", "```text", run.error, "```");
	return `${lines.join("\n")}\n`;
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function htmlReport(runDir: string, run: RunRecord): Promise<string> {
	const variants: string[] = [];
	const summaryRows = run.variants.map((variant) => {
		const metrics = variant.metrics;
		return `<tr><td>${escapeHtml(variant.id)}</td><td><code>${variant.status}</code></td><td>${metrics ? seconds(metrics.activeTimeMs) : "—"}</td><td>${metrics ? seconds(metrics.wallTimeMs) : "—"}</td><td>${metrics ? metrics.cost : "—"}</td><td>${metrics?.toolCalls ?? "—"}</td><td>${metrics ? `${metrics.changedFiles} (+${metrics.insertions}/-${metrics.deletions})` : "—"}</td></tr>`;
	}).join("");
	for (const variant of run.variants) {
		const finalResponse = await readOptional(path.join(runDir, variant.artifacts.finalResponse.path));
		const timeline = await toolTimeline(runDir, variant);
		const links = Object.entries(variant.artifacts)
			.filter(([, reference]) => reference.completeness !== "not_started")
			.map(([name, reference]) => reference.completeness === "unavailable"
				? `<li>${escapeHtml(name)}: unavailable</li>`
				: `<li><a href="${escapeHtml(reference.path.split(path.sep).join("/"))}">${escapeHtml(name)}</a> (${reference.completeness})</li>`)
			.join("");
		const findings = variant.policyFindings.length
			? `<h3>Policy findings</h3><ul>${variant.policyFindings.map((finding) => `<li><strong>${escapeHtml(finding.type)}:</strong> ${escapeHtml(finding.detail)}</li>`).join("")}</ul>`
			: "";
		variants.push(`<section><h2>${escapeHtml(variant.id)}</h2><p><strong>Status:</strong> <code>${variant.status}</code></p>${variant.failurePhase ? `<p><strong>Failure phase:</strong> <code>${escapeHtml(variant.failurePhase)}</code></p>` : ""}<h3>Prompt</h3><pre>${escapeHtml(variant.prompt)}</pre>${variant.error ? `<h3>Operational details</h3><pre>${escapeHtml(variant.error)}</pre>` : ""}${findings}<h3>Final response</h3><pre>${escapeHtml(finalResponse || "Unavailable.")}</pre><h3>Tool timeline</h3>${timeline.length ? `<table><thead><tr><th>Tool</th><th>Outcome</th><th>Duration</th></tr></thead><tbody>${timeline.map((call) => `<tr><td><code>${escapeHtml(call.name)}</code></td><td>${call.completedAt ? (call.isError ? "error" : "completed") : "incomplete"}</td><td>${call.completedAt ? seconds(Date.parse(call.completedAt) - Date.parse(call.startedAt)) : "incomplete"}</td></tr>`).join("")}</tbody></table>` : "<p>No recorded tool calls.</p>"}<h3>Complete evidence</h3><ul>${links}</ul></section>`);
	}
	const diagnosis = run.status === "completed" ? "" : `<section><h2>Failure diagnosis</h2><ul><li><strong>Summary:</strong> ${escapeHtml(failureSummary(run))}</li><li><strong>Failure phase:</strong> <code>${escapeHtml(run.failurePhase ?? "unavailable")}</code></li><li><strong>Structured evidence:</strong> ${run.artifacts.failure ? `<a href="${escapeHtml(run.artifacts.failure.path)}">failure.json</a>` : "unavailable"}</li></ul><h3>Diagnostic hints</h3><ul>${failureHints(run).map((hint) => `<li>${escapeHtml(hint)}</li>`).join("")}</ul></section>`;
	return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(run.name)} skill evaluation</title><style>body{font:16px system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;line-height:1.5}code,pre{font-family:ui-monospace,monospace}pre{white-space:pre-wrap;background:#f4f4f4;padding:1rem;overflow:auto}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:.4rem;text-align:left}section{border-top:1px solid #ccc;margin-top:2rem}</style></head><body><h1>${escapeHtml(run.name)}</h1><ul><li><strong>Run ID:</strong> <code>${run.runId}</code></li><li><strong>Operational status:</strong> <code>${run.status}</code></li><li><strong>Created:</strong> ${run.createdAt}</li><li><strong>Completed:</strong> ${run.completedAt ?? "not completed"}</li><li><strong>Baseline:</strong> <code>${run.baselineSha ?? "unavailable"}</code></li></ul><p><em>Operational status is not a semantic pass/fail judgment.</em></p>${diagnosis}<h2>Variants</h2><table><thead><tr><th>Variant</th><th>Status</th><th>Active</th><th>Wall</th><th>Cost</th><th>Tools</th><th>Changes</th></tr></thead><tbody>${summaryRows}</tbody></table>${variants.join("")}${run.error ? `<h2>Run error</h2><pre>${escapeHtml(run.error)}</pre>` : ""}</body></html>\n`;
}

/** Reports deliberately read only retained artifacts, making regeneration independent of deleted workspaces. */
export async function generateReports(runDir: string): Promise<void> {
	const run = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunRecord;
	await Promise.all([
		markdownReport(runDir, run).then((value) => writeFile(path.join(runDir, "report.md"), value, { mode: 0o600 })),
		htmlReport(runDir, run).then((value) => writeFile(path.join(runDir, "report.html"), value, { mode: 0o600 })),
	]);
}
