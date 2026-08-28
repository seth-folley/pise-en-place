import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { VERSION, type AgentSession, type AgentSessionEvent, type DefaultResourceLoader, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { structuredError } from "./failure.ts";
import type { RunStorage } from "./storage.ts";
import type { MonitorEvent, VariantMetrics } from "./types.ts";

const execFileAsync = promisify(execFile);

function json(value: unknown): string {
	return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return json(content);
	return content.map((item) => {
		if (!item || typeof item !== "object") return String(item);
		const part = item as Record<string, unknown>;
		if (part.type === "text" || part.type === "thinking") return String(part.text ?? part.thinking ?? "");
		if (part.type === "image") return `[image: ${String((part.source as Record<string, unknown> | undefined)?.mediaType ?? "unknown media type")}]`;
		return json(part);
	}).join("\n");
}

function fence(value: string, language = ""): string {
	const longest = Math.max(2, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
	const delimiter = "`".repeat(longest + 1);
	return `${delimiter}${language}\n${value}\n${delimiter}`;
}

function renderMessage(message: unknown): string {
	const value = message as unknown as Record<string, unknown>;
	const role = String(value.role ?? "message");
	if (role === "assistant") {
		const sections: string[] = ["## Assistant"];
		for (const item of Array.isArray(value.content) ? value.content : []) {
			const part = item as Record<string, unknown>;
			if (part.type === "thinking") sections.push(`### Thinking\n\n${String(part.thinking ?? part.text ?? "")}`);
			else if (part.type === "text") sections.push(String(part.text ?? ""));
			else if (part.type === "toolCall") sections.push(`### Tool call: ${String(part.name ?? "unknown")}\n\n${fence(json(part.arguments ?? {}), "json")}`);
			else sections.push(fence(json(part), "json"));
		}
		return sections.join("\n\n");
	}
	if (role === "toolResult") {
		return `## Tool result: ${String(value.toolName ?? "unknown")}\n\n${contentText(value.content)}${value.isError ? "\n\n**Error:** true" : ""}`;
	}
	return `## ${role === "user" ? "User" : role}\n\n${contentText(value.content)}`;
}

export class VariantRecorder {
	readonly toolCallsPath: string;
	readonly systemPromptsPath: string;
	private readonly lifecycle: Array<{ timestamp: string; kind: string; data?: unknown }> = [];
	private queue: Promise<void> = Promise.resolve();
	private lastSystemPromptDigest?: string;
	private turn = 0;

	constructor(
		private readonly storage: RunStorage,
		readonly variantId: string,
		readonly variantDir: string,
		private readonly onMonitorEvent: (event: MonitorEvent) => void,
		private readonly getToolDefinition?: (name: string) => ToolDefinition | undefined,
		private readonly getSystemPrompt?: () => string | undefined,
	) {
		this.toolCallsPath = path.join(variantDir, "tool-calls.jsonl");
		this.systemPromptsPath = path.join(variantDir, "system-prompts.jsonl");
	}

	async initialize(): Promise<void> {
		await mkdir(this.variantDir, { recursive: true });
		await writeFile(this.toolCallsPath, "", { mode: 0o600 });
		await writeFile(this.systemPromptsPath, "", { mode: 0o600 });
	}

	emit(kind: string, data?: unknown, sdkEvent?: AgentSessionEvent, toolDefinition?: ToolDefinition): MonitorEvent {
		const retainedData = data instanceof Error ? structuredError(data) : data;
		const event: MonitorEvent = {
			timestamp: new Date().toISOString(),
			runId: this.storage.record.runId,
			variantId: this.variantId,
			kind,
			data: retainedData,
			sdkEvent,
			toolDefinition,
		};
		this.lifecycle.push({ timestamp: event.timestamp, kind, data: retainedData });
		void this.storage.appendEvent(event);
		this.onMonitorEvent(event);
		return event;
	}

	recordSdkEvent(event: AgentSessionEvent): void {
		const kind = event.type === "tool_execution_start" ? "tool_started"
			: event.type === "tool_execution_update" ? "tool_updated"
			: event.type === "tool_execution_end" ? "tool_completed"
			: event.type === "message_start" ? "message_started"
			: event.type === "message_update" ? "message_updated"
			: event.type === "message_end" ? "message_completed"
			: event.type === "auto_retry_start" ? "retry_started"
			: event.type === "auto_retry_end" ? "retry_completed"
			: event.type === "compaction_start" ? "compaction_started"
			: event.type === "compaction_end" ? "compaction_completed"
			: `sdk_${event.type}`;
		const toolDefinition = "toolName" in event ? this.getToolDefinition?.(String(event.toolName)) : undefined;
		this.emit(kind, event, event, toolDefinition);
		if (event.type === "agent_start") {
			const prompt = this.getSystemPrompt?.();
			if (prompt !== undefined) this.recordSystemPrompt(prompt, this.turn++);
		}
		if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
			this.queue = this.queue.then(() => appendFile(this.toolCallsPath, `${json({ timestamp: new Date().toISOString(), event })}\n`, { mode: 0o600 }));
		}
	}

	get hasSystemPrompt(): boolean {
		return this.lastSystemPromptDigest !== undefined;
	}

	recordSystemPrompt(prompt: string, turn: number): void {
		const digest = createHash("sha256").update(prompt).digest("hex");
		if (digest === this.lastSystemPromptDigest) return;
		this.lastSystemPromptDigest = digest;
		const snapshot = { timestamp: new Date().toISOString(), turn, sha256: digest, prompt };
		this.queue = this.queue.then(() => appendFile(this.systemPromptsPath, `${json(snapshot)}\n`, { mode: 0o600 }));
		if (turn === 0) this.queue = this.queue.then(() => writeFile(path.join(this.variantDir, "system-prompt.md"), prompt, { mode: 0o600 }));
	}

	async writeResources(session: AgentSession, loader: DefaultResourceLoader): Promise<void> {
		const extensions = loader.getExtensions();
		const gitVersion = await execFileAsync("git", ["--version"]).then(({ stdout }) => stdout.trim()).catch(() => "unavailable");
		const skills = loader.getSkills();
		const resources = {
			model: session.model ? `${session.model.provider}/${session.model.id}` : null,
			thinking: session.thinkingLevel,
			activeTools: session.getActiveToolNames(),
			tools: session.getAllTools().map((tool) => ({ name: tool.name, sourceInfo: tool.sourceInfo })),
			extensions: extensions.extensions.map((extension) => ({ path: extension.path, resolvedPath: extension.resolvedPath, sourceInfo: extension.sourceInfo })),
			extensionErrors: extensions.errors,
			skills: skills.skills.map((skill) => ({ name: skill.name, path: skill.filePath })),
			skillDiagnostics: skills.diagnostics,
			contextFiles: loader.getAgentsFiles().agentsFiles.map((file) => ({ path: file.path, sha256: createHash("sha256").update(file.content).digest("hex") })),
			prompts: loader.getPrompts().prompts.map((prompt) => ({ name: prompt.name, path: prompt.filePath })),
			settings: {
				retry: session.settingsManager.getRetrySettings(),
				providerRetry: session.settingsManager.getProviderRetrySettings(),
				compaction: session.settingsManager.getCompactionSettings(),
			},
			platform: { pi: VERSION, node: process.version, os: process.platform, arch: process.arch, git: gitVersion },
		};
		await writeFile(path.join(this.variantDir, "resources.json"), `${JSON.stringify(resources, null, 2)}\n`, { mode: 0o600 });
	}

	async finalizeSession(session: AgentSession, metrics: VariantMetrics): Promise<void> {
		await this.queue;
		const finalResponse = session.getLastAssistantText() ?? "";
		await writeFile(path.join(this.variantDir, "final-response.md"), finalResponse, { mode: 0o600 });
		await writeFile(path.join(this.variantDir, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`, { mode: 0o600 });

		const entries = session.sessionManager.getEntries();
		const transcript: string[] = [`# Transcript: ${this.variantId}`, ""];
		for (const entry of entries) {
			if (entry.type === "message") transcript.push(renderMessage(entry.message), "");
			else if (entry.type === "custom_message") transcript.push(`## Custom message${entry.display ? "" : " (hidden)"}: ${entry.customType}\n\n${contentText(entry.content)}`, "");
			else if (entry.type === "compaction") transcript.push(`## Compaction\n\n${entry.summary}`, "");
			else transcript.push(`## Session entry: ${entry.type}\n\n${fence(json(entry), "json")}`, "");
		}
		const lifecycle = this.lifecycle.filter((event) => /retry|compaction|timed_out|cancelled|harness_error|interaction_blocked/.test(event.kind));
		if (lifecycle.length > 0) transcript.push("## Harness lifecycle", "", fence(JSON.stringify(lifecycle, null, 2), "json"), "");
		await writeFile(path.join(this.variantDir, "transcript.md"), `${transcript.join("\n").trimEnd()}\n`, { mode: 0o600 });
	}
}
