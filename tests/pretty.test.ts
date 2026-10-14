import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initTheme, ToolExecutionComponent, type ExtensionAPI, type Theme, type ToolRendererResolver, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import pretty, { FORMATTERS } from "../extensions/ui/pretty/index.ts";
import { PrettyRegistry } from "../extensions/ui/pretty/registry.ts";
import { recognizeXcode, xcodeRenderers } from "../extensions/ui/pretty/xcode.ts";

type Context = Parameters<NonNullable<ToolRenderers["renderResult"]>>[3];
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const context = (extra: Partial<Context> = {}): Context => ({ args: {}, toolCallId: "fixture", invalidate: vi.fn(), lastComponent: undefined,
	state: {}, cwd: "/synthetic", executionStarted: true, argsComplete: true, isPartial: false, expanded: false,
	showImages: false, isError: false, durationMs: undefined, outputPad: 1, ...extra });
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: undefined });
const render = (definition: ToolRenderers, value: unknown, expanded = false, ctx = context()) => definition.renderResult!(text(value), { expanded, isPartial: false }, theme, ctx).render(120).join("\n");
const base: ToolRenderers = {
	renderCall: () => new Text("ORIGINAL CALL", 0, 0),
	renderResult: result => new Text("ORIGINAL RESULT\n" + result.content.filter(c => c.type === "text").map(c => c.text).join("\n"), 0, 0),
};
// Recognition fixtures are synthetic, NOT captured Apple results or assertions of its wire contract.
const build = { buildResult: "Server-reported build outcome", errors: ["first error", "second error", "third error", "fourth error"], warnings: ["a warning"], extra: "EXTRA_RAW_FIELD" };
function setup() {
	let resolver: ToolRendererResolver;
	let command: Parameters<ExtensionAPI["registerCommand"]>[1];
	const handlers = new Map<string, () => void>();
	const api = { registerToolRenderer: vi.fn((value: ToolRendererResolver) => { resolver = value; }),
		registerCommand: vi.fn((_name, value) => { command = value; }), on: vi.fn((name, fn) => handlers.set(name, fn)) } as unknown as ExtensionAPI;
	pretty(api);
	const notify = vi.fn();
	return { api, resolver: resolver!, command: command!, notify, handlers,
		async run(args: string) { await command.handler(args, { ui: { notify } } as any); },
	};
}

let root: string;
beforeAll(async () => { root = await mkdtemp(path.join(os.tmpdir(), "pretty-tests-")); vi.stubEnv("PI_CODING_AGENT_DIR", root); initTheme("dark", false); });
afterAll(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe("session-only /pretty", () => {
	it("shows states without toggling and adds no settings/tools/processes", async () => {
		const s = setup(); await s.run("");
		expect(s.api.registerCommand).toHaveBeenCalledWith("pretty", expect.any(Object)); expect(s.notify.mock.lastCall?.[0]).toContain("session only");
		for (const f of FORMATTERS) expect(s.notify.mock.lastCall?.[0]).toContain(`${f.id}: on`);
		expect(s.api.on).toHaveBeenCalledTimes(1);
	});
	it("lists every formatter's description and current state without toggling or redrawing", async () => {
		const s = setup(); const renderer = s.resolver(FORMATTERS[0].toolName, () => base)!; const ctx = context();
		render(renderer, build, false, ctx); await s.run("xcode-build off"); vi.mocked(ctx.invalidate).mockClear();
		await s.run("list"); const listed = s.notify.mock.lastCall?.[0];
		for (const f of FORMATTERS) expect(listed).toContain(`${f.id}: ${f.id === "xcode-build" ? "off" : "on"} — ${f.description}`);
		expect(s.notify.mock.lastCall?.[1]).toBe("info"); expect(ctx.invalidate).not.toHaveBeenCalled();
		await s.run(""); expect(s.notify.mock.lastCall?.[0]).toBe(listed);
	});
	it("toggles individual, group and all formatters and resets at a new session", async () => {
		const s = setup(); const renderer = s.resolver(FORMATTERS[0].toolName, () => base)!;
		const ctx = context(); render(renderer, build, false, ctx);
		await s.run("xcode-build off"); expect(render(renderer, build, false, ctx)).toContain("ORIGINAL RESULT"); expect(ctx.invalidate).toHaveBeenCalledTimes(1);
		expect(s.notify.mock.lastCall?.[0]).toContain("xcode-log: on");
		await s.run("xcode off"); expect(s.notify.mock.lastCall?.[0]).toContain("xcode-issues: off");
		await s.run("on"); expect(render(renderer, build, false, ctx)).not.toContain("ORIGINAL RESULT");
		await s.run("off"); s.handlers.get("session_start")!(); expect(render(renderer, build, false, ctx)).not.toContain("ORIGINAL RESULT");
		const calls = vi.mocked(ctx.invalidate).mock.calls.length; await s.run("off"); expect(ctx.invalidate).toHaveBeenCalledTimes(calls + 1);
	});
	it.each(["unknown off", "xcode toggle", "on off extra", "garbage", "all off", "list off"])("rejects invalid input without changing state (%s)", async args => {
		const s = setup(); await s.run(args); expect(s.notify.mock.lastCall?.[1]).toBe("warning");
		await s.run(""); expect(s.notify.mock.lastCall?.[0]).toContain("xcode-build: on");
	});
	it("provides help and completions", async () => {
		const s = setup(); await s.run("--help"); expect(s.notify.mock.lastCall?.[0]).toContain("/pretty [list]");
		expect(await s.command.getArgumentCompletions?.("li")).toEqual([{ value: "list", label: "list" }]);
		expect((await s.command.getArgumentCompletions?.("xcode-build o"))?.map(v => v.value)).toEqual(["xcode-build on", "xcode-build off"]);
		expect(await s.command.getArgumentCompletions?.("xcode-")).toHaveLength(3); expect(await s.command.getArgumentCompletions?.("unknown ")).toBeNull();
	});
	it("leaves unrelated tools and self-shell renderers alone", () => {
		const s = setup(); expect(s.resolver("mcp__other__BuildProject", () => base)).toBe(base);
		const custom = { ...base, renderShell: "self" as const }; expect(s.resolver(FORMATTERS[0].toolName, () => custom)).toBe(custom);
	});
	it("does not break older hosts lacking renderer registration", () => {
		const registerCommand = vi.fn(); pretty({ registerCommand } as unknown as ExtensionAPI); expect(registerCommand).not.toHaveBeenCalled();
	});
});

describe("conservative Xcode result views", () => {
	it("shows explicit reported result/counts and at most three collapsed errors without claiming success", () => {
		const registry = new PrettyRegistry(FORMATTERS); const r = xcodeRenderers("build", "xcode-build", registry, base);
		const out = render(r, build); expect(out).toContain("Reported result: Server-reported build outcome");
		expect(out).toContain("4 error entries · 1 warning entries"); expect(out).toContain("third error"); expect(out).not.toContain("fourth error"); expect(out).not.toContain("✓");
		const expanded = render(r, build, true); expect(expanded).toContain("fourth error"); expect(expanded).toContain("EXTRA_RAW_FIELD"); expect(expanded).toContain("Raw response:");
	});
	it("shows filtered returned log entries, severity, locations, running state and pagination honestly", () => {
		const r = xcodeRenderers("log", "xcode-log", new PrettyRegistry(FORMATTERS), base);
		const out = render(r, { buildIsRunning: true, hasMore: true, totalFound: 100, buildLogEntries: [
			{ category: "error", message: "bad type", path: "Sources/🍎.swift", lineNumber: 12 },
			{ category: "warning", message: "warning" }, { category: "note", message: "note" },
		] });
		expect(out).toContain("Build still running"); expect(out).toContain("1 error entries · 1 warning entries · 1 other entries");
		expect(out).toContain("returned entries only"); expect(out).toContain("More results available"); expect(out).toContain("Sources/🍎.swift:12 — bad type"); expect(out).not.toContain("100 errors");
	});
	it("does not equate successful diagnostic refresh or empty returned lists with successful builds", () => {
		const r = xcodeRenderers("issues", "xcode-issues", new PrettyRegistry(FORMATTERS), base);
		expect(render(r, { success: true, diagnostics: [] })).toContain("not a build-success check");
		expect(render(r, { success: false, diagnostics: [] })).toContain("refresh reported failure");
		expect(render(r, { success: true, diagnostics: [] })).not.toContain("Build succeeded");
	});
	it.each(["plain prose says success", { buildResult: "success" }, { buildResult: "success", errors: [null] }, { buildResult: "success", errors: [], warnings: "unknown" }, null, ["unknown"]])("falls back for unsupported payloads (%j)", value => {
		const r = xcodeRenderers("build", "xcode-build", new PrettyRegistry(FORMATTERS), base); expect(render(r, value)).toContain("ORIGINAL RESULT");
	});
	it.each([
		{ buildResult: "reported", errors: [{ message: "actual error", category: "note" }] },
		{ buildResult: "reported", errors: [], warnings: [{ message: "warning", severity: "error" }] },
		{ buildResult: "reported", errors: [{ message: "conflict", category: "error", severity: "note" }] },
	])("does not hide build-array entries with conflicting severity labels (%j)", value => {
		const r = xcodeRenderers("build", "xcode-build", new PrettyRegistry(FORMATTERS), base);
		expect(render(r, value)).toContain("ORIGINAL RESULT"); expect(render(r, value)).not.toContain("0 error entries");
	});
	it.each([1, "new-unknown-severity"])("falls back rather than classifying unsupported log severity (%j)", severity => {
		const r = xcodeRenderers("log", "xcode-log", new PrettyRegistry(FORMATTERS), base);
		expect(render(r, { buildLogEntries: [{ message: "diagnostic", severity }] })).toContain("ORIGINAL RESULT");
	});
	it.each([
		{ buildResult: "", buildLogEntries: [] }, { buildResult: 1, buildLogEntries: [] },
		{ buildIsRunning: "true", buildLogEntries: [] }, { hasMore: 1, buildLogEntries: [] },
		{ buildLogEntries: [{ message: "error", category: "error", path: 1 }] },
		{ buildLogEntries: [{ message: "error", category: "error", filePath: {} }] },
		{ buildLogEntries: [{ message: "error", category: "error", line: 0 }] },
		{ buildLogEntries: [{ message: "error", category: "error", lineNumber: "12" }] },
		{ buildLogEntries: [{ message: "error", category: "error", lineNumber: 1.5 }] },
		{ buildLogEntries: [{ message: "error", category: "error", path: "A.swift", filePath: "B.swift" }] },
		{ buildLogEntries: [{ message: "error", category: "error", lineNumber: 1, line: 2 }] },
	])("does not hide malformed known state/location fields (%j)", value => {
		const r = xcodeRenderers("log", "xcode-log", new PrettyRegistry(FORMATTERS), base);
		expect(render(r, value)).toContain("ORIGINAL RESULT");
	});
	it("preserves partial, transport-error, multi-block and image results via the original renderer", () => {
		const r = xcodeRenderers("build", "xcode-build", new PrettyRegistry(FORMATTERS), base);
		for (const [result, partial, ctx] of [
			[text(build), true, context()], [text(build), false, context({ isError: true })],
			[{ content: [...text(build).content, { type: "text", text: "SECOND_BLOCK" }], details: undefined }, false, context()],
			[{ content: [{ type: "image", data: "fixture", mimeType: "image/png" }], details: undefined }, false, context()],
		] as const) expect(r.renderResult!(result as any, { expanded: false, isPartial: partial }, theme, ctx).render(120).join("\n")).toContain("ORIGINAL RESULT");
	});
	it("keeps original expanded arguments and disabled call views", () => {
		const registry = new PrettyRegistry(FORMATTERS); const r = xcodeRenderers("build", "xcode-build", registry, base);
		expect(r.renderCall!({ workspaceIdentifier: "workspace1" }, theme, context()).render(80).join("\n")).toContain("workspace1");
		expect(r.renderCall!({}, theme, context({ expanded: true })).render(80).join("\n")).toContain("ORIGINAL CALL");
		registry.set("xcode-build", false); expect(r.renderCall!({}, theme, context()).render(80).join("\n")).toContain("ORIGINAL CALL");
	});
	it("does not mutate result data and sanitizes terminal control strings in its own view", () => {
		const r = xcodeRenderers("build", "xcode-build", new PrettyRegistry(FORMATTERS), base);
		const data = { buildResult: "\x1b[31mreported\x1b[0m", errors: ["\x1b]52;c;DANGEROUS\x07bad\x00error"] };
		const result = Object.freeze({ content: Object.freeze([Object.freeze({ type: "text" as const, text: JSON.stringify(data) })]), details: undefined });
		const out = r.renderResult!(result as any, { expanded: false, isPartial: false }, theme, context()).render(100).join("\n");
		expect(out).not.toContain("DANGEROUS"); expect(out).not.toContain("\x00"); expect(result.content[0].text).toBe(JSON.stringify(data));
	});
	it("re-evaluates theme colors instead of caching styled output", () => {
		const r = xcodeRenderers("build", "xcode-build", new PrettyRegistry(FORMATTERS), base), ctx = context();
		for (const name of ["first", "second"]) {
			const custom = { fg: (_color: string, value: string) => `[${name}]${value}`, bold: (value: string) => value } as Theme;
			const out = r.renderResult!(text(build), { expanded: false, isPartial: false }, custom, ctx).render(120).join("\n");
			expect(out).toContain(`[${name}]Reported result:`);
		}
	});
	it("handles malformed/oversized JSON and refreshes cached recognized results after changes", () => {
		expect(recognizeXcode("build", "{broken")).toBeUndefined(); expect(recognizeXcode("build", " ".repeat(1_000_001))).toBeUndefined();
		const r = xcodeRenderers("build", "xcode-build", new PrettyRegistry(FORMATTERS), base); const ctx = context();
		expect(render(r, build, false, ctx)).toContain("4 error entries"); expect(render(r, { ...build, errors: [] }, false, ctx)).toContain("0 error entries");
	});
	it("retains saved full-output paths", () => {
		const r = xcodeRenderers("build", "xcode-build", new PrettyRegistry(FORMATTERS), base);
		const result = { ...text(build), details: { fullOutputPath: "/synthetic/full.log" } };
		expect(r.renderResult!(result, { expanded: false, isPartial: false }, theme, context()).render(100).join("\n")).toContain("Full output: /synthetic/full.log");
	});
});

describe("public Pi tool-row integration (no server/model)", () => {
	it("renders resumed calls before registration and redraws existing rows on toggles without recursion", async () => {
		const s = setup(); const name = FORMATTERS[0].toolName; const r = s.resolver(name, () => undefined)!;
		const requestRender = vi.fn(); const row = new ToolExecutionComponent(name, "resumed", {}, { showImages: false }, r, { requestRender } as unknown as TUI, root);
		row.updateResult({ ...text(build), isError: false });
		expect(stripTerminalSequences(row.render(100).join("\n"))).toContain("Reported result:");
		await s.run("off"); expect(requestRender).toHaveBeenCalled(); expect(stripTerminalSequences(row.render(100).join("\n"))).not.toContain("Reported result:");
		await s.run("on"); expect(stripTerminalSequences(row.render(100).join("\n"))).toContain("Reported result:");
		row.setExpanded(true); expect(stripTerminalSequences(row.render(100).join("\n"))).toContain("EXTRA_RAW_FIELD");
	});
	it.each([0, 1, 3])("respects native padding and narrow/wide Unicode layouts (pad %i)", outputPad => {
		const s = setup(); const name = FORMATTERS[1].toolName; const row = new ToolExecutionComponent(name, "narrow", {}, { outputPad, showImages: false }, s.resolver(name, () => base), { requestRender() {} } as unknown as TUI, root);
		row.updateResult({ ...text({ buildLogEntries: [{ category: "error", message: "錯誤 🍎 " + "long".repeat(20), path: "文件.swift", line: 1 }] }), isError: false });
		for (const width of [12, 30, 100]) for (const rendered of row.render(width)) expect(visibleWidth(rendered)).toBeLessThanOrEqual(width);
	});
});
