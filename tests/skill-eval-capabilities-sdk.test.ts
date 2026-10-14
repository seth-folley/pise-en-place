import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import * as Pi from "@earendil-works/pi-coding-agent";
import { loadSkillEvalConfig } from "../extensions/evals/skill-eval/config.ts";
import { runEvaluation } from "../extensions/evals/skill-eval/runner.ts";

vi.mock("@earendil-works/pi-coding-agent", async importOriginal => {
	const actual = await importOriginal<typeof Pi>();
	return { ...actual, createAgentSession: vi.fn(actual.createAgentSession), createMcpExtension: vi.fn(actual.createMcpExtension) };
});
let root: string, agentDir: string;
const realCreateRuntime = Pi.ModelRuntime.create.bind(Pi.ModelRuntime);
beforeEach(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "eval-capabilities-")); agentDir = path.join(root, "agent");
	await mkdir(agentDir);
	vi.stubEnv("HOME", root); vi.stubEnv("PI_CODING_AGENT_DIR", agentDir); vi.stubEnv("PI_OFFLINE", "1");
	for (const variable of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]) vi.stubEnv(variable, path.join(root, "unused-git-config"));
	vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
	for (const variable of ["GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_TEMPLATE_DIR", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) vi.stubEnv(variable, undefined);
	vi.spyOn(Pi.ModelRuntime, "create").mockImplementation(async options => {
		const runtime = await realCreateRuntime({ ...options, modelsStorePath: path.join(root, "catalog.json"), allowModelNetwork: false });
		await runtime.setRuntimeApiKey("anthropic", "fake-test-key"); return runtime;
	});
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
});
afterEach(async () => {
	vi.restoreAllMocks(); vi.mocked(Pi.createAgentSession).mockReset(); vi.mocked(Pi.createMcpExtension).mockReset();
	vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
});

async function run(options: { tools?: string[]; script?: string; direct?: string; search?: boolean; mcp?: unknown; projectMcp?: unknown;
	extension?: string; hang?: boolean; cancel?: boolean; resourceFailure?: boolean; failConnect?: boolean; changeTrust?: boolean } = {}) {
	const project = path.join(root, "project"); await mkdir(project);
	await writeFile(path.join(project, "value.txt"), "SYNTHETIC_READ_RESULT");
	if (options.mcp !== undefined) await writeFile(path.join(agentDir, "mcp.json"), typeof options.mcp === "string" ? options.mcp : JSON.stringify(options.mcp));
	if (options.projectMcp !== undefined) {
		await mkdir(path.join(project, ".pi")); await writeFile(path.join(project, ".pi", "mcp.json"), JSON.stringify(options.projectMcp));
	}
	if (options.extension) {
		await mkdir(path.join(project, ".pi", "extensions"), { recursive: true });
		await writeFile(path.join(project, ".pi", "extensions", "register.ts"), options.extension);
	}
	const configPath = path.join(root, "eval.yaml");
	await writeFile(configPath, `version: 1\nname: capabilities\nworkspace: ./project\nagent:\n  harness: pi\n  model: anthropic/claude-sonnet-4-5\n${options.tools ? `  tools: ${JSON.stringify(options.tools)}\n` : ""}limits:\n  timeoutSeconds: ${options.hang ? 1 : 15}\nvariants:\n  first:\n    prompt: Use the requested capabilities.\n  second:\n    prompt: A second independent variant.\n`);
	const actual = await vi.importActual<typeof Pi>("@earendil-works/pi-coding-agent");
	const connections: { name: string; cwd: string; source: string; closed: boolean }[] = [];
	const mcpCalls: { server: string; tool: string }[] = [];
	const toolsSeen: string[][] = [], results: string[] = [], sdkEvents: Pi.AgentSessionEvent[] = [];
	let requests = 0, shutdowns = 0;
	vi.mocked(Pi.createMcpExtension).mockImplementation(config => actual.createMcpExtension({ ...config, createTransport: (entry, cwd) => {
		const connection = { name: entry.name, cwd, source: entry.source, closed: false }; connections.push(connection);
		type Transport = ReturnType<Pi.McpTransportFactory>;
		const listeners = new Set<Parameters<Transport["onMessage"]>[0]>();
		const closeListeners = new Set<Parameters<Transport["onClose"]>[0]>();
		return {
			async start() {}, async close() { connection.closed = true; for (const listener of closeListeners) listener(); },
			onMessage(listener) { listeners.add(listener); return () => listeners.delete(listener); },
			onError() { return () => {}; }, onClose(listener) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
			async send(message) {
				if (!("method" in message) || !("id" in message)) return;
				if (options.failConnect && message.method === "initialize") throw new Error("Synthetic connection failure");
				let result: unknown;
				if (message.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "synthetic", version: "1" } };
				else if (message.method === "tools/list") result = { tools: ["echo", "erase"].map(name => ({ name, description: `${entry.name} ${name} fixture`, inputSchema: { type: "object", properties: { value: { type: "string" } } } })) };
				else if (message.method === "tools/call") {
					const params = message.params as { name: string };
					mcpCalls.push({ server: entry.name, tool: params.name });
					if (options.hang) return;
					result = { content: [{ type: "text", text: "SYNTHETIC_MCP_RESULT" }] };
				} else result = {};
				queueMicrotask(() => { for (const listener of listeners) listener({ jsonrpc: "2.0", id: message.id!, result }); });
			},
		};
	} }));
	vi.mocked(Pi.createAgentSession).mockImplementation(async config => {
		const created = await actual.createAgentSession(config); const session = created.session;
		if (options.changeTrust) session.settingsManager.setProjectTrusted(false);
		let turn = 0;
		const emit = session.extensionRunner!.emit.bind(session.extensionRunner!);
		vi.spyOn(session.extensionRunner!, "emit").mockImplementation(async event => { if (event.type === "session_shutdown") shutdowns++; return emit(event); });
		session.subscribe(event => sdkEvents.push(event));
		session.agent.streamFunction = (model, context) => {
			requests++; turn++;
			toolsSeen.push(session.getActiveToolNames());
			const last = context.messages[context.messages.length - 1];
			if (last.role === "toolResult") results.push(last.content.map(part => part.type === "text" ? part.text : "").join("\n"));
			const call: AssistantMessage["content"] = options.script && turn === 1 ? [{ type: "toolCall", id: "script", name: "codemode", arguments: { code: options.script } }]
				: options.search && turn === 1 ? [{ type: "toolCall", id: "search", name: "tool_search", arguments: { query: "echo", limit: 5 } }]
				: options.direct && (turn === 1 || options.search && turn === 2) ? [{ type: "toolCall", id: "direct", name: options.direct, arguments: { value: "fixture" } }]
				: [{ type: "text", text: "Complete." }];
			const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: call,
				stopReason: call[0].type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now(),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }); stream.end(); return stream;
		};
		if (options.resourceFailure) {
			const getAllTools = session.getAllTools.bind(session);
			vi.spyOn(session, "getAllTools").mockImplementation(() => { if (turn > 0) throw new Error("Synthetic resource refresh failure"); return getAllTools(); });
		}
		return created;
	});
	const controller = new AbortController();
	const result = await runEvaluation(await loadSkillEvalConfig(configPath), { agentDir, baseDir: path.join(root, "runs"),
		parentUI: { notify() {} } as unknown as Pi.ExtensionUIContext, signal: controller.signal,
		onEvent(event) {
			if (options.cancel && event.kind === "variant_started") controller.abort();
		},
	});
	return { result, connections, mcpCalls, requests, shutdowns, toolsSeen, results, sdkEvents, project };
}
const configs = (exposure = "codemode") => ({ mcpServers: {
	docs: { command: "DO_NOT_EXECUTE", exposure }, unrelated: { command: "MUST_NOT_START", env: { SECRET: "!MUST_NOT_RUN" } },
} });

describe("opt-in eval capability SDK integration", () => {
	it.each([undefined, ["read"]])("keeps existing defaults/ordinary selections offline without MCP loading (%s)", async tools => {
		const s = await run({ tools, mcp: configs() });
		expect(s.result.status).toBe("completed"); expect(s.connections).toEqual([]); expect(Pi.createMcpExtension).not.toHaveBeenCalled();
		expect(s.toolsSeen.flat()).not.toContain("codemode"); expect(s.toolsSeen.flat()).not.toContain("tool_search");
	}, 20_000);
	it("runs real codemode nested read with a wildcard allowlist and no MCP", async () => {
		const s = await run({ tools: ["codemode", "read*"], script: 'return await tools.read({path:"value.txt"});', mcp: configs() });
		expect(s.result.status).toBe("completed"); expect(s.results.join("\n")).toContain("SYNTHETIC_READ_RESULT"); expect(s.connections).toEqual([]);
		expect(s.sdkEvents.some(event => event.type === "tool_execution_start" && event.toolName === "read" && !!event.parentToolCallId)).toBe(true);
		expect(s.result.storage.record.variants[0].policyFindings).toEqual([]);
	}, 20_000);
	it("waits for selected codemode MCP tools and never starts unrelated configured/late extension servers", async () => {
		const s = await run({ tools: ["codemode", "mcp__docs__*"], mcp: configs(),
			extension: 'export default function(pi) { pi.registerMcpServer("early_other", {command:"DO_NOT_START"}); pi.on("agent_start",()=>pi.registerMcpServer("late_other",{command:"DO_NOT_START"})); }',
			script: 'return await tools.mcp__docs__echo({value:"fixture"});' });
		expect(s.result.status).toBe("completed"); expect(s.connections.map(connection => connection.name)).toEqual(["docs", "docs"]);
		expect(s.connections.every(connection => connection.closed)).toBe(true); expect(s.mcpCalls).toEqual([{ server: "docs", tool: "echo" }, { server: "docs", tool: "echo" }]);
		expect(s.results.join("\n")).toContain("SYNTHETIC_MCP_RESULT"); expect(s.shutdowns).toBe(2);
		const resources = await readFile(path.join(s.result.storage.variantDir("first"), "resources.json"), "utf8");
		expect(resources).toContain("mcp__docs__echo"); expect(resources).not.toContain("MUST_NOT_RUN"); expect(resources).not.toContain("skill_eval_validation_");
		expect(s.connections.every(connection => connection.cwd.includes(s.result.storage.runDir))).toBe(true);
		expect(await readFile(path.join(s.project, "value.txt"), "utf8")).toBe("SYNTHETIC_READ_RESULT");
	}, 25_000);
	it("connects only selected extension registrations, including a selected late registration", async () => {
		const s = await run({ tools: ["codemode", "mcp__docs*__*"],
			extension: 'export default function(pi) { pi.registerMcpServer("docs",{command:"FAKE"}); pi.registerMcpServer("other",{command:"DO_NOT_START"}); pi.on("agent_start",()=>pi.registerMcpServer("docs_late",{command:"FAKE"})); }',
			script: 'const found = await searchTools("echo"); return await tools.mcp__docs_late__echo({});' });
		expect(s.result.status).toBe("completed"); expect(s.connections.map(connection => connection.name).sort()).toEqual(["docs", "docs", "docs_late", "docs_late"]);
		expect(s.mcpCalls).toEqual([{ server: "docs_late", tool: "echo" }, { server: "docs_late", tool: "echo" }]);
		expect(s.connections.every(connection => connection.closed)).toBe(true);
	}, 25_000);
	it("does not retain validation registrations even when all MCP namespaces are explicitly selected", async () => {
		const s = await run({ tools: ["codemode", "mcp__*"], mcp: configs() });
		expect(s.result.status).toBe("completed"); expect(s.connections.map(connection => connection.name).sort()).toEqual(["docs", "docs", "unrelated", "unrelated"]);
		expect(s.connections.every(connection => connection.closed)).toBe(true);
	}, 25_000);
	it("honors a project exposure override without modifying global or original project config", async () => {
		const projectMcp = { mcpServers: { docs: { exposure: "direct" } } }, global = JSON.stringify(configs());
		const s = await run({ tools: ["mcp__docs__echo"], mcp: global, projectMcp, direct: "mcp__docs__echo" });
		expect(s.result.status).toBe("completed"); expect(s.toolsSeen[0]).toContain("mcp__docs__echo");
		expect(await readFile(path.join(agentDir, "mcp.json"), "utf8")).toBe(global);
		expect(await readFile(path.join(s.project, ".pi", "mcp.json"), "utf8")).toBe(JSON.stringify(projectMcp));
	}, 25_000);
	it("fails before binding an independently discovered replacement MCP manager", async () => {
		const s = await run({ tools: ["codemode", "mcp__docs__*"], mcp: configs(),
			extension: 'export default function(pi) { pi.registerCommand("mcp",{description:"replacement",handler:async()=>{}}); pi.on("session_start",()=>{throw new Error("MUST_NOT_START");}); }' });
		expect(s.result.status).toBe("harness_error"); expect(s.result.storage.record.variants[0].error).toContain("replaced by another MCP extension");
		expect(s.requests).toBe(0); expect(s.connections).toEqual([]); expect(s.shutdowns).toBe(0);
	}, 20_000);
	it("loads deferred MCP tools through real tool_search for the next model request", async () => {
		const s = await run({ tools: ["tool_search", "mcp__docs__*"], mcp: configs("deferred"), search: true, direct: "mcp__docs__echo" });
		expect(s.result.status).toBe("completed"); expect(s.results.join("\n")).toContain("SYNTHETIC_MCP_RESULT");
		expect(s.toolsSeen[0]).toContain("tool_search"); expect(s.toolsSeen[0]).not.toContain("mcp__docs__echo"); expect(s.toolsSeen[1]).toContain("mcp__docs__echo");
		expect(s.connections.every(connection => connection.closed)).toBe(true);
	}, 25_000);
	it.each(["codemode", "tool_search"])("fails before binding a replacement %s tool", async tool => {
		const s = await run({ tools: [tool],
			extension: `export default function(pi) { pi.registerTool({name:"${tool}",label:"replacement",description:"replacement",parameters:{type:"object"},execute:async()=>{throw new Error("MUST_NOT_EXECUTE");}}); pi.on("session_start",()=>{throw new Error("MUST_NOT_START");}); }` });
		expect(s.result.status).toBe("harness_error"); expect(s.result.storage.record.variants[0].error).toContain(`Pi eval tool ${tool} is unavailable or replaced`);
		expect(s.requests).toBe(0); expect(s.connections).toEqual([]); expect(s.shutdowns).toBe(0);
	}, 20_000);
	it("uses one normalized allowlist for MCP selection, SDK tools and runtime policy", async () => {
		const s = await run({ tools: [" codemode ", " mcp__docs__echo "], mcp: configs(), script: 'return await tools.mcp__docs__echo({});' });
		expect(s.result.status).toBe("completed"); expect(s.results.join("\n")).toContain("SYNTHETIC_MCP_RESULT"); expect(s.mcpCalls).toHaveLength(2);
		expect(s.result.storage.record.variants[0].policyFindings).toEqual([]);
	}, 25_000);
	it("supports exact MCP tool selections without granting sibling tools", async () => {
		const s = await run({ tools: ["mcp__docs__echo"], mcp: configs("direct"), direct: "mcp__docs__echo" });
		expect(s.result.status).toBe("completed"); expect(s.mcpCalls.every(call => call.tool === "echo")).toBe(true);
		expect(s.toolsSeen[0]).toContain("mcp__docs__echo"); expect(s.toolsSeen.flat()).not.toContain("mcp__docs__erase");
	}, 25_000);
	it("keeps disallowed MCP siblings out of the SDK codemode callable set", async () => {
		const s = await run({ tools: ["codemode", "mcp__docs__echo"], mcp: configs(), script: 'return await tools.mcp__docs__erase({});' });
		expect(s.mcpCalls).toEqual([]); expect(s.results.join("\n")).toContain("Script failed");
		// SDK rejects the unavailable script method before tool_call; don't invent a policy event.
		expect(s.result.status).toBe("completed"); expect(s.result.storage.record.variants[0].policyFindings).toEqual([]);
	}, 25_000);
	it("blocks SDK-preserved MCP-style extension tools on the real nested pipeline", async () => {
		// Without an mcp__ entry SDK allowlists preserve MCP tools; the evaluator must still deny them.
		const s = await run({ tools: ["codemode"], script: 'return await tools.mcp__outside__erase({});',
			extension: 'export default function(pi) { pi.registerTool({name:"mcp__outside__erase",label:"outside",description:"deferred forbidden fixture",parameters:{type:"object"},exposure:"deferred",execute:async()=>{throw new Error("MUST_NOT_EXECUTE");}}); }' });
		expect(s.result.status).toBe("policy_stopped");
		expect(s.result.storage.record.variants[0].policyFindings).toMatchObject([{ type: "tool_policy_violation", detail: "Denied disallowed tool mcp__outside__erase" }]);
		expect(s.results.join("\n")).toContain("Denied disallowed tool mcp__outside__erase"); expect(s.results.join("\n")).not.toContain("MUST_NOT_EXECUTE");
		expect(s.result.storage.record.variants[1].status).toBe("pending");
	}, 20_000);
	it("does not let tool_search discover or activate out-of-allowlist deferred extension tools", async () => {
		const s = await run({ tools: ["tool_search"], search: true,
			extension: 'export default function(pi) { pi.registerTool({name:"mcp__outside__erase",label:"outside",description:"echo forbidden fixture",parameters:{type:"object"},exposure:"deferred",execute:async()=>{throw new Error("MUST_NOT_EXECUTE");}}); }' });
		expect(s.result.status).toBe("completed"); expect(s.toolsSeen.flat()).not.toContain("mcp__outside__erase"); expect(s.results.join("\n")).not.toContain("mcp__outside__erase");
	}, 20_000);
	it.each([
		[{ mcpServers: { docs: { command: "fake", exposure: "invalid" } } }, "exposure must"], ['{"mcpServers":{"docs":{"headers":{"Authorization":"SECRET_VALUE"},BAD}}}', "invalid MCP JSON"],
	])("fails selected configuration before connections or provider requests", async (mcp, error) => {
		const s = await run({ tools: ["codemode", "mcp__docs__*"], mcp });
		expect(s.result.status).toBe("harness_error"); expect(s.connections).toEqual([]); expect(s.requests).toBe(0);
		expect(s.result.storage.record.variants[0].error).toContain(error); expect(s.result.storage.record.variants[0].error).not.toContain("SECRET_VALUE");
	}, 20_000);
	it.each([{}, { mcpServers: { docs: { command: "fake", enabled: false } } }])("preserves lazy startup for missing/disabled servers without enabling or connecting them", async mcp => {
		const s = await run({ tools: ["codemode", "mcp__docs__*"], mcp, script: 'return await searchTools("echo");' });
		expect(s.result.status).toBe("completed"); expect(s.connections).toEqual([]); expect(s.mcpCalls).toEqual([]);
	}, 20_000);
	it.each(["session_start", "agent_start"])("allows the only selected server to register at %s", async event => {
		const s = await run({ tools: ["codemode", "mcp__docs__*"],
			extension: `export default function(pi) { pi.on("${event}",()=>pi.registerMcpServer("docs",{command:"FAKE"})); }`,
			script: 'return await tools.mcp__docs__echo({});' });
		expect(s.result.status).toBe("completed"); expect(s.mcpCalls).toHaveLength(2); expect(s.connections.map(connection => connection.name)).toEqual(["docs", "docs"]);
		expect(s.connections.every(connection => connection.closed)).toBe(true);
	}, 25_000);
	it("retains normal SDK/tool evidence for a selected server connection failure", async () => {
		const s = await run({ tools: ["codemode", "mcp__docs__*"], mcp: configs(), failConnect: true, script: 'return await tools.mcp__docs__echo({});' });
		expect(s.result.status).toBe("completed"); expect(s.mcpCalls).toEqual([]); expect(s.results.join("\n")).toContain("Script failed");
		expect(await readFile(s.result.storage.eventsPath, "utf8")).toContain("Synthetic connection failure");
		expect(s.connections.every(connection => connection.closed)).toBe(true);
	}, 25_000);
	it("does not claim an exact but nonexistent requested MCP tool is available", async () => {
		const s = await run({ tools: ["codemode", "mcp__docs__missing"], mcp: configs(), script: 'return await tools.mcp__docs__missing({});' });
		expect(s.result.status).toBe("completed"); expect(s.mcpCalls).toEqual([]); expect(s.results.join("\n")).toContain("Script failed");
		expect(s.toolsSeen.flat()).not.toContain("mcp__docs__missing");
	}, 25_000);
	it("fails closed if project trust changes between configuration snapshot and startup", async () => {
		const s = await run({ tools: ["codemode", "mcp__docs__*"], mcp: configs(), changeTrust: true });
		expect(s.result.status).toBe("harness_error"); expect(s.requests).toBe(0); expect(s.connections).toEqual([]);
		expect(s.result.storage.record.variants[0].error).toContain("Project trust changed");
	}, 20_000);
	it("closes selected transports after cancellation before a provider request", async () => {
		const s = await run({ tools: ["codemode", "mcp__docs__*"], mcp: configs(), cancel: true });
		expect(s.result.status).toBe("cancelled"); expect(s.requests).toBe(0); expect(s.connections).toHaveLength(1); expect(s.connections.every(connection => connection.closed)).toBe(true); expect(s.shutdowns).toBe(1);
	}, 20_000);
	it("closes selected transports after timeout in a nested MCP request", async () => {
		const s = await run({ tools: ["codemode", "mcp__docs__*"], mcp: configs(), script: 'return await tools.mcp__docs__echo({});', hang: true });
		expect(s.result.status).toBe("timed_out"); expect(s.connections).toHaveLength(1); expect(s.connections[0].closed).toBe(true);
		expect(s.result.storage.record.variants[1].status).toBe("pending");
	}, 20_000);
	it("still closes transports if final capability-resource evidence fails", async () => {
		const s = await run({ tools: ["mcp__docs__echo"], mcp: configs("direct"), direct: "mcp__docs__echo", resourceFailure: true });
		expect(s.result.status).toBe("harness_error"); expect(s.connections).toHaveLength(1); expect(s.connections[0].closed).toBe(true); expect(s.shutdowns).toBe(1);
		expect(s.result.storage.record.variants[0].artifacts.resources.completeness).toBe("partial");
	}, 20_000);
});
