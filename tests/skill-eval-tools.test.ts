import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSelectedMcpConfig } from "../extensions/evals/skill-eval/mcp-config.ts";
import { mcpNamespace, mcpToolPatterns, selectsMcpServer, toolNameMatcher } from "../extensions/evals/skill-eval/tool-selection.ts";
import { createEvalCapabilities } from "../extensions/evals/skill-eval/capabilities.ts";
import { loadSkillEvalConfig } from "../extensions/evals/skill-eval/config.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), "eval-tools-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function setup(global: unknown, project?: unknown) {
	const agentDir = path.join(root, "agent"), cwd = path.join(root, "project");
	mkdirSync(agentDir); mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	writeFileSync(path.join(agentDir, "mcp.json"), typeof global === "string" ? global : JSON.stringify(global));
	if (project !== undefined) writeFileSync(path.join(cwd, ".pi", "mcp.json"), typeof project === "string" ? project : JSON.stringify(project));
	return { agentDir, cwd, projectTrusted: true, patterns: ["mcp__docs__*"], validate: (_config: unknown) => {} };
}

describe("eval tool selection", () => {
	it("uses exact names and * only, preserving case and literal regex characters", () => {
		const matches = toolNameMatcher([" read ", "mcp__docs__get_*", "foo.[x]+?", "tool**"]);
		for (const name of ["read", "mcp__docs__get_value", "foo.[x]+?", "tool", "tool_extra"]) expect(matches(name)).toBe(true);
		for (const name of ["Read", "write", "mcp__other__get_value", "fooaax"]) expect(matches(name)).toBe(false);
	});
	it.each([
		["mcp__docs__*", "docs", true], ["mcp__docs__echo", "docs", true], ["mcp__docs__echo", "docs_more", false],
		["mcp__dev_radius__get_*", "dev-radius", true], ["mcp__do*__echo", "docs", true], ["mcp__*", "anything", true],
		["mcp__docs", "docs", false], ["mcp__foo__bar__echo", "foo__bar", true], ["mcp__foo__bar__echo", "foo", true],
	] as const)("selects potential server owners for %s / %s: %s", (pattern, server, expected) => {
		expect(selectsMcpServer([pattern], server)).toBe(expected);
	});
	it("requires explicit mcp__ intent, not generic * or resource-tool names", () => {
		expect(mcpToolPatterns(["*", "list_mcp_resources", " mcp__docs__echo "])).toEqual(["mcp__docs__echo"]);
		expect(mcpNamespace("dev-radius")).toBe("mcp__dev_radius");
	});
	it("does not mount optional capabilities when tools are omitted or ordinary", () => {
		const options = { cwd: root, agentDir: root, projectTrusted: () => true };
		expect(createEvalCapabilities(undefined, options).factories).toEqual([]);
		expect(createEvalCapabilities(["read", "bash"], options).factories).toEqual([]);
	});
	it("validates patterns without checking availability, but rejects +/- defaults modifiers", async () => {
		const yaml = path.join(root, "eval.yaml");
		const source = (tools: string) => `version: 1\nname: tools\nworkspace: .\nagent:\n  harness: pi\n  model: fake/model\n  tools: ${tools}\nvariants:\n  first:\n    prompt: Test.\n`;
		writeFileSync(yaml, source('[" codemode ", tool_search, " mcp__docs__* "]'));
		expect((await loadSkillEvalConfig(yaml)).config.agent.tools).toEqual(["codemode", "tool_search", "mcp__docs__*"]);
		writeFileSync(yaml, source('["+codemode"]'));
		await expect(loadSkillEvalConfig(yaml)).rejects.toThrow("not a +/- defaults modifier");
	});
	it("rejects allowlist entries that become duplicates after normalization", async () => {
		const yaml = path.join(root, "eval.yaml");
		writeFileSync(yaml, 'version: 1\nname: duplicate\nworkspace: .\nagent:\n  harness: pi\n  model: fake/model\n  tools: [read, " read "]\nvariants:\n  first:\n    prompt: Test.\n');
		await expect(loadSkillEvalConfig(yaml)).rejects.toThrow("unique after trimming");
	});
});

describe("selected-only MCP configuration", () => {
	it("merges selected project overrides without resolving env/header commands or validating unselected entries", () => {
		const options = setup({ mcpServers: { docs: { url: "https://invalid.example/mcp", headers: { Authorization: "!DO_NOT_RUN" }, auth: { provider: "fake" } }, other: "invalid" } },
			{ autoEnableCodemode: false, mcpServers: { docs: { exposure: "deferred", toolExposure: { echo: "direct" } }, other: { command: "DO_NOT_START" } } });
		let validations = 0;
		const loaded = loadSelectedMcpConfig({ ...options, validate: () => { validations++; } });
		expect(validations).toBe(2); expect(loaded.errors).toEqual([]); expect(loaded.servers).toHaveLength(1);
		expect(loaded).toMatchObject({ autoEnableCodemode: false, projectConfig: path.join(options.cwd, ".pi", "mcp.json") });
		expect(loaded.servers[0]).toMatchObject({ name: "docs", scope: "global", source: path.join(options.agentDir, "mcp.json"),
			override: path.join(options.cwd, ".pi", "mcp.json"), config: { headers: { Authorization: "!DO_NOT_RUN" }, auth: { provider: "fake" }, exposure: "deferred" } });
	});
	it("does not read an untrusted project file", () => {
		const options = setup({ mcpServers: { docs: { command: "global" } } }, "invalid-secret-json");
		const loaded = loadSelectedMcpConfig({ ...options, projectTrusted: false });
		expect(loaded.errors).toEqual([]); expect(loaded.projectConfig).toBeUndefined(); expect(loaded.servers[0].config).toEqual({ command: "global" });
	});
	it("fully replaces a global server and normalizes documented exposure aliases", () => {
		const options = setup({ mcpServers: { docs: { command: "global", env: { TOKEN: "secret" } } } },
			{ mcpServers: { docs: { command: "project", exposure: "codemode-deferred", toolExposure: { echo: "codemode-deferred" } } } });
		const loaded = loadSelectedMcpConfig(options);
		expect(loaded.errors).toEqual([]); expect(loaded.servers[0]).toMatchObject({ scope: "project", source: path.join(options.cwd, ".pi", "mcp.json") });
		expect(loaded.servers[0].config).toEqual({ command: "project", exposure: "codemode", toolExposure: { echo: "codemode" } });
	});
	it.each([
		[{ docs: { enabled: false } }, "override needs a global server"],
		[{ docs: { url: "https://invalid.example/mcp", auth: { provider: "fake" } } }, "auth is only allowed"],
	])("rejects invalid or privileged project entries", (entries, message) => {
		const loaded = loadSelectedMcpConfig(setup({ mcpServers: {} }, { mcpServers: entries }));
		expect(loaded.errors.join("\n")).toContain(message);
	});
	it("rejects an override that redirects credentials, keeping the base entry", () => {
		const loaded = loadSelectedMcpConfig(setup({ mcpServers: { docs: { url: "https://invalid.example/mcp", headers: { Authorization: "secret" } } } },
			{ mcpServers: { docs: { headers: { Authorization: "redirect" } } } }));
		expect(loaded.errors.join("\n")).toContain("override may only set"); expect(loaded.servers[0].config).toMatchObject({ headers: { Authorization: "secret" } });
	});
	it("rejects normalized namespace collisions", () => {
		const options = setup({ mcpServers: { "dev-radius": { command: "first" }, dev_radius: { command: "second" } } });
		const loaded = loadSelectedMcpConfig({ ...options, patterns: ["mcp__dev_radius__*"] });
		expect(loaded.errors.join("\n")).toContain("namespace conflicts"); expect(loaded.servers).toHaveLength(1);
	});
	it("does not quote secret-bearing malformed JSON in diagnostics", () => {
		const loaded = loadSelectedMcpConfig(setup('{"mcpServers":{"docs":{"headers":{"Authorization":"SECRET_VALUE"},BAD}}}'));
		expect(loaded.errors.join("\n")).toContain("invalid MCP JSON"); expect(loaded.errors.join("\n")).not.toContain("SECRET_VALUE");
	});
	it("keeps disabled entries disabled, and isolates selected validation errors", () => {
		const options = setup({ mcpServers: { docs: { command: "fake", enabled: false }, other: { command: "unselected" } } });
		expect(loadSelectedMcpConfig(options).servers[0].config.enabled).toBe(false);
		const loaded = loadSelectedMcpConfig({ ...options, validate: () => { throw new Error("invalid selected config"); } });
		expect(loaded.errors).toHaveLength(1); expect(loaded.servers).toEqual([]);
	});
});
