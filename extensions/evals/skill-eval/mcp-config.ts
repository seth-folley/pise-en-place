import { readFileSync } from "node:fs";
import path from "node:path";
import type { LoadedMcpConfig, McpServerConfig, McpServerEntry } from "@earendil-works/pi-coding-agent";
import { mcpNamespace, selectsMcpServer } from "./tool-selection.ts";

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Public registration validates configs; the only normalization is Pi's documented exposure alias. */
function normalizeExposure(config: McpServerConfig): McpServerConfig {
	const alias = (value: unknown) => value === "codemode-deferred" ? "codemode" : value;
	return { ...config,
		...(config.exposure === undefined ? {} : { exposure: alias(config.exposure) as McpServerConfig["exposure"] }),
		...(config.toolExposure === undefined ? {} : { toolExposure: Object.fromEntries(Object.entries(config.toolExposure).map(([name, exposure]) => [name, alias(exposure)])) as McpServerConfig["toolExposure"] }),
	};
}

/** Selected-only normal global/trusted-project merge. No env/header command resolution or writes.
 * validate must use the public SDK during resource loading, before any session is bound.
 * Keep this adapter local until Pi exports a selected-server loader.
 */
export function loadSelectedMcpConfig(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	patterns: readonly string[];
	validate: (config: unknown) => void;
}): LoadedMcpConfig {
	const servers = new Map<string, McpServerEntry>(), errors: string[] = [];
	let autoEnableCodemode: boolean | undefined;
	const read = (file: string, scope: "global" | "project") => {
		let source: string;
		try { source = readFileSync(file, "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${file}: cannot read MCP configuration`);
			return;
		}
		let parsed: unknown;
		try { parsed = JSON.parse(source); }
		catch { errors.push(`${file}: invalid MCP JSON`); return; } // Parser errors can quote secrets.
		if (!record(parsed) || (parsed.mcpServers !== undefined && !record(parsed.mcpServers))) {
			errors.push(`${file}: expected an object with an mcpServers object`); return;
		}
		if (typeof parsed.autoEnableCodemode === "boolean") autoEnableCodemode = parsed.autoEnableCodemode;
		else if (parsed.autoEnableCodemode !== undefined) errors.push(`${file}: autoEnableCodemode must be a boolean`);
		for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
			if (!selectsMcpServer(options.patterns, name)) continue;
			try {
				if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("invalid MCP server name");
				if (scope === "project" && record(value) && value.command === undefined && value.url === undefined && value.type === undefined) {
					const base = servers.get(name);
					if (!base) throw new Error("override needs a global server");
					if (Object.keys(value).some(key => !["enabled", "exposure", "toolExposure"].includes(key))) throw new Error("override may only set enabled, exposure, toolExposure");
					const config = { ...base.config, ...value };
					options.validate(config);
					servers.set(name, { ...base, config: normalizeExposure(config as McpServerConfig), override: file });
					continue;
				}
				options.validate(value);
				const config = normalizeExposure(structuredClone(value) as McpServerConfig);
				if (scope === "project" && "url" in config && config.auth) throw new Error("auth is only allowed in global mcp.json");
				const clash = [...servers.keys()].find(other => other !== name && mcpNamespace(other) === mcpNamespace(name));
				if (clash) throw new Error(`namespace conflicts with ${clash}`);
				servers.set(name, { name, config, source: file, scope });
			} catch (error) {
				// Registration validation messages contain field names, not config values.
				errors.push(`${file}: server ${name}: ${error instanceof Error ? error.message : "invalid configuration"}`);
			}
		}
	};
	read(path.join(options.agentDir, "mcp.json"), "global");
	const projectConfig = options.projectTrusted ? path.join(options.cwd, ".pi", "mcp.json") : undefined;
	if (projectConfig) read(projectConfig, "project");
	return { servers: [...servers.values()], errors, autoEnableCodemode, ...(projectConfig ? { projectConfig } : {}) };
}
