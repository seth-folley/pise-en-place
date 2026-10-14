import * as Pi from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { loadSelectedMcpConfig } from "./mcp-config.ts";
import { mcpToolPatterns, selectsMcpServer, toolNameMatcher } from "./tool-selection.ts";

/** Optional Pi capabilities are requested only by the explicit eval allowlist. */
export function createEvalCapabilities(tools: readonly string[] | undefined, options: {
	cwd: string; agentDir: string; projectTrusted: () => boolean;
}) {
	const matches = toolNameMatcher(tools ?? []);
	const patterns = mcpToolPatterns(tools);
	const factories: Pi.InlineExtension[] = [];
	let loaded: Pi.LoadedMcpConfig = { servers: [], errors: [] };
	const requireFactory = (name: "createCodemodeExtension" | "createToolSearchExtension" | "createMcpExtension") => {
		const version = /^(\d+)\.(\d+)\./.exec(Pi.VERSION);
		if (!version || Number(version[1]) < 1 || Number(version[1]) === 1 && Number(version[2]) < 2 || typeof Pi[name] !== "function") {
			throw new Error(`Requested eval capabilities require Pi 1.2 (${name} unavailable or unsupported)`);
		}
	};
	if (matches("codemode")) {
		requireFactory("createCodemodeExtension");
		factories.push({ name: "codemode", replaceable: true, factory: Pi.createCodemodeExtension() });
	}
	if (matches("tool_search")) {
		requireFactory("createToolSearchExtension");
		factories.push({ name: "tool-search", replaceable: true, factory: pi => Pi.createToolSearchExtension()({
			...pi,
			getAllTools: () => pi.getAllTools().filter(tool => matches(tool.name)),
			setActiveTools: names => pi.setActiveTools(names.filter(matches)),
		}) });
	}
	if (patterns.length) {
		requireFactory("createMcpExtension");
		factories.push({ name: "skill-eval-mcp", replaceable: true, factory: pi => {
			// Public registration validates synchronously; mutations are queued until factory commit.
			// Immediately unregister the unique validation name: nothing survives to session_start.
			// We do not try to read the queued normalized registry entry (it is not visible yet).
			const validationName = `skill_eval_validation_${randomUUID().replace(/-/g, "_")}`;
			const projectTrusted = options.projectTrusted();
			loaded = loadSelectedMcpConfig({ ...options, projectTrusted, patterns,
				validate: config => {
					pi.registerMcpServer(validationName, config as Pi.McpServerConfig);
					pi.unregisterMcpServer(validationName);
				},
			});
			return Pi.createMcpExtension({
				loadConfig: ctx => {
					// Do not use a trusted-project snapshot if an extension changed trust during startup.
					if (ctx.isProjectTrusted() !== projectTrusted) {
						loaded = { servers: [], errors: ["Project trust changed during MCP startup; restart the evaluation"] };
					}
					return loaded;
				},
				logPath: path.join(options.agentDir, "mcp.log"),
				// The read-only eval monitor must not persist manager edits into user mcp.json.
				updateConfig: () => { throw new Error("MCP configuration is read-only during an evaluation"); },
			})({ ...pi, getMcpServers: () => loaded.errors.length ? [] : pi.getMcpServers().filter(server => selectsMcpServer(patterns, server.name)) });
		} });
	}
	return {
		factories,
		assertLoaded(loader: Pi.DefaultResourceLoader): void {
			const loadedPaths = new Set(loader.getExtensions().extensions.map(extension => extension.path));
			for (const [tool, inline] of [["codemode", "codemode"], ["tool_search", "tool-search"]]) {
				if (matches(tool) && !loadedPaths.has(`<inline:${inline}>`)) {
					throw new Error(`Requested Pi eval tool ${tool} is unavailable or replaced by another extension`);
				}
			}
			if (!patterns.length) return;
			if (!loadedPaths.has("<inline:skill-eval-mcp>")) {
				throw new Error("Selected MCP loading is unavailable or replaced by another MCP extension");
			}
			if (loaded.errors.length) throw new Error(loaded.errors.join("\n"));
			// Tool availability is intentionally lazy, like Pi: servers may register during
			// session_start or later, and scripts/search wait for the servers they reach.
			// Unknown tools/connection failures are agent/tool evidence, not config errors.
		},
		assertTools(session: Pi.AgentSession): void {
			for (const name of ["codemode", "tool_search"]) {
				if (matches(name) && !session.getAllTools().some(tool => tool.name === name && tool.exposure !== "hidden")) {
					throw new Error(`Requested eval tool is unavailable: ${name}`);
				}
			}
		},
	};
}
