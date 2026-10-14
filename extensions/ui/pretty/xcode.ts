import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import type { PrettyRegistry } from "./registry.ts";

export type XcodeKind = "build" | "log" | "issues";
type Kind = XcodeKind;
type Issue = { message: string; category: string; path?: string; line?: number };
type Summary = { reported?: string; issues: Issue[]; running?: boolean; refresh?: boolean; more?: boolean };
const CACHE = Symbol("xcode-pretty-cache");
const titles = { build: "Xcode build", log: "Xcode build log", issues: "Xcode diagnostics" };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const clean = (text: string): string => stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const line = (text: string): string => clean(text).replace(/[\r\n\t\u2028\u2029]+/g, " ");

function issue(value: unknown, defaultCategory = "other"): Issue | undefined {
	if (typeof value === "string" && value.trim() && defaultCategory !== "other") return { message: value, category: defaultCategory };
	if (!object(value) || typeof value.message !== "string" || !value.message.trim()) return;
	if (value.category !== undefined && typeof value.category !== "string" || value.severity !== undefined && typeof value.severity !== "string") return;
	if (typeof value.category === "string" && typeof value.severity === "string" && value.category.toLowerCase() !== value.severity.toLowerCase()) return;
	const category = typeof value.category === "string" ? value.category : typeof value.severity === "string" ? value.severity : defaultCategory;
	if (!["error", "warning", "note", "remark", "information", "other"].includes(category.toLowerCase())) return;
	// Conflicting labels are ambiguous, never grounds to hide an entry in a named errors array.
	if (defaultCategory !== "other" && category.toLowerCase() !== defaultCategory) return;
	for (const key of ["path", "filePath"]) if (value[key] !== undefined && typeof value[key] !== "string") return;
	for (const key of ["lineNumber", "line"]) if (value[key] !== undefined && (!integer(value[key]) || (value[key] as number) < 1)) return;
	if (value.path !== undefined && value.filePath !== undefined && value.path !== value.filePath) return;
	if (value.lineNumber !== undefined && value.line !== undefined && value.lineNumber !== value.line) return;
	const path = typeof value.path === "string" ? value.path : typeof value.filePath === "string" ? value.filePath : undefined;
	const n = value.lineNumber ?? value.line;
	return { message: value.message, category: category.toLowerCase(), path, line: n as number | undefined };
}

/** Shape recognition, not an assertion of Apple's undocumented wire contract. Never infer build success from prose. */
export function recognizeXcode(kind: Kind, text: string): Summary | undefined {
	if (text.length > 1_000_000) return;
	let data: unknown;
	try { data = JSON.parse(text); } catch { return; }
	if (!object(data)) return;
	if (data.buildResult !== undefined && (typeof data.buildResult !== "string" || !data.buildResult.trim())) return;
	for (const key of ["buildIsRunning", "hasMore"]) if (data[key] !== undefined && typeof data[key] !== "boolean") return;
	const values = kind === "build" ? data.errors : kind === "log" ? data.buildLogEntries : data.diagnostics;
	if (!Array.isArray(values)) return;
	if (kind === "build" && data.warnings !== undefined && !Array.isArray(data.warnings)) return;
	const issues = [
		...values.map(value => issue(value, kind === "build" ? "error" : "other")),
		...(kind === "build" && Array.isArray(data.warnings) ? data.warnings.map(value => issue(value, "warning")) : []),
	];
	if (issues.some(value => !value)) return;
	if (kind === "build" && typeof data.buildResult !== "string") return;
	if (kind === "issues" && typeof data.success !== "boolean") return;
	return {
		issues: issues as Issue[],
		reported: typeof data.buildResult === "string" ? data.buildResult : undefined,
		running: typeof data.buildIsRunning === "boolean" ? data.buildIsRunning : undefined,
		refresh: kind === "issues" ? data.success as boolean : undefined,
		more: data.hasMore === true,
	};
}

/** Missing next-renderer means let Pi's own component use its generic fallback. */
function fallback(): never { throw new Error("Use Pi's original renderer fallback"); }

export function xcodeRenderers(kind: Kind, id: string, registry: PrettyRegistry, base: ToolRenderers | undefined): ToolRenderers {
	return {
		// Both our view and the native MCP fallback use the default shell; Pi owns outputPad/images/expansion.
		renderShell: "default",
		renderCall(args, theme, context) {
			registry.track(context);
			if (!registry.enabled(id) || context.expanded) return base?.renderCall?.(args, theme, { ...context, lastComponent: undefined }) ?? fallback();
			const workspace = object(args) && typeof args.workspaceIdentifier === "string" ? ` · ${line(args.workspaceIdentifier)}` : "";
			const file = kind === "issues" && object(args) && typeof args.filePath === "string" ? ` · ${line(args.filePath)}` : "";
			return new Text(theme.fg("toolTitle", theme.bold(titles[kind])) + theme.fg("muted", file || workspace), 0, 0);
		},
		renderResult(result, options, theme, context) {
			registry.track(context);
			const original = () => base?.renderResult?.(result, options, theme, { ...context, lastComponent: undefined }) ?? fallback();
			if (!registry.enabled(id) || options.isPartial || context.isError || result.content.length !== 1 || result.content[0]?.type !== "text") return original();
			const raw = result.content[0].text;
			let cached = context.state[CACHE] as { kind: Kind; text: string; summary?: Summary } | undefined;
			if (!cached || cached.kind !== kind || cached.text !== raw) context.state[CACHE] = cached = { kind, text: raw, summary: recognizeXcode(kind, raw) };
			const summary = cached.summary;
			if (!summary) return original();
			const errors = summary.issues.filter(item => item.category === "error");
			const warnings = summary.issues.filter(item => item.category === "warning");
			const other = summary.issues.length - errors.length - warnings.length;
			const counts = `${errors.length} error entries · ${warnings.length} warning entries` + (other ? ` · ${other} other entries` : "");
			const lines: string[] = [];
			if (summary.reported) lines.push(theme.fg("toolOutput", `Reported result: ${line(summary.reported)}`));
			if (summary.running === true) lines.push(theme.fg("warning", "Build still running"));
			if (summary.refresh !== undefined) lines.push(theme.fg(summary.refresh ? "toolOutput" : "error", summary.refresh ? "Diagnostics refreshed (not a build-success check)" : "Diagnostic refresh reported failure"));
			lines.push(theme.fg(errors.length ? "error" : warnings.length ? "warning" : "muted", `${counts} (returned entries only)`));
			if (summary.more) lines.push(theme.fg("warning", "More results available from Xcode"));
			if (options.expanded) {
				for (const item of summary.issues) lines.push(theme.fg(item.category === "error" ? "error" : item.category === "warning" ? "warning" : "toolOutput", formatIssue(item)));
				lines.push(theme.fg("muted", "Raw response:"), theme.fg("toolOutput", clean(raw).replace(/\t/g, "  ")));
			} else {
				for (const item of errors.slice(0, 3)) lines.push(theme.fg("error", formatIssue(item)));
				lines.push(keyHint("app.tools.expand", "details / raw output"));
			}
			const fullOutputPath = object(result.details) && typeof result.details.fullOutputPath === "string" ? result.details.fullOutputPath : undefined;
			if (fullOutputPath) lines.push(theme.fg("muted", `Full output: ${line(fullOutputPath)}`));
			const component = new Container(); component.addChild(new Text(lines.join("\n"), 0, 0)); return component;
		},
	};
}

function formatIssue(item: Issue): string {
	const location = item.path ? `${line(item.path)}${item.line ? `:${item.line}` : ""} — ` : item.line ? `line ${item.line} — ` : "";
	return `${location}${line(item.message)}`;
}
