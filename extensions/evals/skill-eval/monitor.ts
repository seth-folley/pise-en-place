import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Text, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { NormalizedSkillEvalConfig } from "./config.ts";
import { failureSummary } from "./failure.ts";
import type { EvaluationRunResult } from "./runner.ts";
import type { ExecutionPhase, ExecutionStatus, MonitorEvent } from "./types.ts";

const statusGlyph: Record<string, string> = {
	pending: "○",
	preparing: "◌",
	running: "●",
	completed: "✓",
	timed_out: "⌛",
	interaction_blocked: "?",
	policy_finding: "!",
	policy_stopped: "!",
	cancelled: "⊘",
	harness_error: "✗",
};

type MonitorVariantStatus = ExecutionStatus | "policy_finding";

interface ToolRow {
	component: ToolExecutionComponent;
}

/** The monitor renders SDK messages with Pi's native components while owning only viewport state. */
export class SkillEvalMonitor implements Component {
	private readonly statuses = new Map<string, MonitorVariantStatus>();
	private readonly variantPhases = new Map<string, ExecutionPhase>();
	private readonly variantStartedAt = new Map<string, number>();
	private readonly variantFinishedAt = new Map<string, number>();
	private readonly transcript: Component[] = [];
	private readonly tools = new Map<string, ToolRow>();
	private activeVariant?: string;
	private activePhase: ExecutionPhase = "initialize_storage";
	private activeWorkspace = process.cwd();
	private assistant?: AssistantMessageComponent;
	private expanded = false;
	private scrollFromBottom = 0;
	private settled?: EvaluationRunResult;
	private fatalError?: string;
	private startedAt = Date.now();
	private finishedAt?: number;
	private disposed = false;
	private readonly ticker: NodeJS.Timeout;

	constructor(
		private readonly config: NormalizedSkillEvalConfig,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly abort: () => void,
		private readonly close: () => void,
	) {
		for (const id of Object.keys(config.variants)) this.statuses.set(id, "pending");
		this.ticker = setInterval(() => this.tui.requestRender(), 250);
	}

	onEvent(event: MonitorEvent): void {
		if (event.kind === "run_phase_changed" || event.kind === "variant_phase_changed") {
			const phase = (event.data as { phase?: unknown } | undefined)?.phase;
			if (typeof phase === "string") {
				this.activePhase = phase as ExecutionPhase;
				if (event.variantId) {
					this.variantPhases.set(event.variantId, this.activePhase);
					if (this.activePhase === "settled") {
						this.variantFinishedAt.set(event.variantId, this.eventTime(event));
						if (this.statuses.get(event.variantId) === "running") this.statuses.set(event.variantId, "completed");
					}
				}
			}
		}
		if (event.kind === "variant_preparing" && event.variantId) {
			this.activeVariant = event.variantId;
			this.variantStartedAt.set(event.variantId, this.eventTime(event));
		}
		if (event.variantId) {
			const status = event.kind === "variant_preparing" ? "preparing"
				: event.kind === "variant_started" ? "running"
				: event.kind === "variant_timed_out" ? "timed_out"
				: event.kind === "variant_interaction_blocked" ? "interaction_blocked"
				: event.kind === "variant_cancelled" ? "cancelled"
				: event.kind === "variant_harness_error" ? "harness_error"
				: undefined;
			if (status) this.statuses.set(event.variantId, status);
		}
		if (event.kind === "variant_started" && event.variantId) {
			this.activeVariant = event.variantId;
			this.activeWorkspace = String((event.data as Record<string, unknown> | undefined)?.workspace ?? process.cwd());
			this.transcript.length = 0;
			this.tools.clear();
			this.assistant = undefined;
			this.scrollFromBottom = 0;
		}
		this.consumeSdkEvent(event);
		if (/retry|compaction|policy_violation|timed_out|interaction_blocked|harness_error|cancelled/.test(event.kind)) {
			this.transcript.push(new Text(this.theme.fg("warning", `• ${event.kind.replaceAll("_", " ")}`), 1, 0));
		}
		this.tui.requestRender();
	}

	fail(error: unknown): void {
		this.fatalError = error instanceof Error ? error.message : String(error);
		this.finishedAt = Date.now();
		this.tui.requestRender();
	}

	finish(result: EvaluationRunResult): void {
		this.settled = result;
		this.finishedAt = Date.now();
		for (const variant of result.storage.record.variants) {
			this.statuses.set(variant.id, variant.policyFindings.length > 0 ? "policy_finding" : variant.status);
		}
		this.tui.requestRender();
	}

	private consumeSdkEvent(event: MonitorEvent): void {
		const sdk = event.sdkEvent;
		if (!sdk) return;
		if (sdk.type === "message_start") {
			const message = sdk.message as unknown as Record<string, unknown>;
			if (message.role === "user") this.transcript.push(new UserMessageComponent(this.messageText(message), undefined));
			if (sdk.message.role === "assistant") {
				this.assistant = new AssistantMessageComponent(sdk.message, false);
				this.transcript.push(this.assistant);
			}
		}
		if (sdk.type === "message_update" && this.assistant) this.assistant.updateContent(sdk.message as AssistantMessage);
		if (sdk.type === "message_end" && sdk.message.role === "assistant" && this.assistant) {
			this.assistant.updateContent(sdk.message);
		}
		if (sdk.type === "tool_execution_start") {
			const component = new ToolExecutionComponent(sdk.toolName, sdk.toolCallId, sdk.args, {}, event.toolDefinition, this.tui, this.activeWorkspace);
			component.markExecutionStarted();
			component.setArgsComplete();
			component.setExpanded(this.expanded);
			this.tools.set(sdk.toolCallId, { component });
			this.transcript.push(component);
		}
		if (sdk.type === "tool_execution_update") {
			this.tools.get(sdk.toolCallId)?.component.updateResult(sdk.partialResult, true);
		}
		if (sdk.type === "tool_execution_end") {
			this.tools.get(sdk.toolCallId)?.component.updateResult({ ...sdk.result, isError: sdk.isError }, false);
		}
	}

	private messageText(message: Record<string, unknown>): string {
		if (typeof message.content === "string") return message.content;
		if (!Array.isArray(message.content)) return "";
		return message.content.map((part) => typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : "[attachment]").join("\n");
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "app.tools.expand")) {
			this.expanded = !this.expanded;
			for (const row of this.tools.values()) row.component.setExpanded(this.expanded);
		} else if (this.keybindings.matches(data, "tui.altScreen.pageUp")) {
			this.scrollFromBottom += Math.max(5, Math.floor(this.tui.terminal.rows * 0.7));
		} else if (this.keybindings.matches(data, "tui.altScreen.pageDown")) {
			this.scrollFromBottom = Math.max(0, this.scrollFromBottom - Math.max(5, Math.floor(this.tui.terminal.rows * 0.7)));
		} else if (this.keybindings.matches(data, "tui.altScreen.bottom")) {
			this.scrollFromBottom = 0;
		} else if (this.keybindings.matches(data, "app.interrupt")) {
			if (this.settled || this.fatalError) this.close(); else this.abort();
		} else if ((this.settled || this.fatalError) && this.keybindings.matches(data, "tui.input.submit")) {
			this.close();
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const elapsed = (((this.finishedAt ?? Date.now()) - this.startedAt) / 1000).toFixed(1);
		const status = this.settled?.status ?? (this.fatalError ? "harness_error" : "running");
		const header = [
			truncateToWidth(this.theme.fg("accent", this.theme.bold(`Skill eval: ${this.config.name}`)), safeWidth),
			truncateToWidth(this.theme.fg("muted", `${status} • ${elapsed}s • ${this.config.agent.model} • timeout ${this.config.limits.timeoutSeconds}s active`), safeWidth),
			truncateToWidth(this.theme.fg("muted", this.phaseDescription()), safeWidth),
		];
		if (this.settled) {
			const record = this.settled.storage.record;
			if (record.status !== "completed") {
				header.push(truncateToWidth(this.theme.fg("warning", `${failureSummary(record)} Evidence: ${record.artifacts.failure.path}`), safeWidth));
			}
			const attempted = record.variants.filter((variant) => variant.status !== "pending");
			const metrics = attempted.flatMap((variant) => variant.metrics ? [variant.metrics] : []);
			const numericCosts = metrics.flatMap((item) => typeof item.cost === "number" ? [item.cost] : []);
			const cost = numericCosts.length > 0 ? `$${numericCosts.reduce((sum, item) => sum + item, 0).toFixed(4)}` : "cost unavailable";
			header.push(truncateToWidth(this.theme.fg("muted", `${attempted.length}/${this.settled.storage.record.variants.length} attempted • ${metrics.reduce((sum, item) => sum + item.inputTokens + item.outputTokens, 0)} tokens • ${cost} • ${metrics.reduce((sum, item) => sum + item.toolCalls, 0)} tools • ${metrics.reduce((sum, item) => sum + item.changedFiles, 0)} files`), safeWidth));
		}
		const variantLines = this.variantLines(safeWidth);
		const submitKeys = this.keybindings.getKeys("tui.input.submit").join("/") || "submit";
		const interruptKeys = this.keybindings.getKeys("app.interrupt").join("/") || "interrupt";
		const expandKeys = this.keybindings.getKeys("app.tools.expand").join("/") || "tools expand";
		const pageUpKeys = this.keybindings.getKeys("tui.altScreen.pageUp").join("/") || "page up";
		const pageDownKeys = this.keybindings.getKeys("tui.altScreen.pageDown").join("/") || "page down";
		const footerText = this.settled
			? `${submitKeys}/${interruptKeys} close • ${this.settled.storage.runDir}`
			: this.fatalError
				? `Harness error: ${this.fatalError} • ${submitKeys}/${interruptKeys} close`
				: `${expandKeys} ${this.expanded ? "collapse" : "expand"} tools • ${pageUpKeys}/${pageDownKeys} scroll • ${interruptKeys} cancel`;
		const fixed = header.length + variantLines.length + 2;
		const bodyHeight = Math.max(1, this.tui.terminal.rows - fixed);
		const body = this.renderTranscript(safeWidth);
		const maxOffset = Math.max(0, body.length - bodyHeight);
		this.scrollFromBottom = Math.min(this.scrollFromBottom, maxOffset);
		const end = body.length - this.scrollFromBottom;
		const start = Math.max(0, end - bodyHeight);
		const viewport = body.slice(start, end);
		while (viewport.length < bodyHeight) viewport.push("");
		return [...header, ...variantLines, this.theme.fg("borderMuted", "─".repeat(safeWidth)), ...viewport, truncateToWidth(this.theme.fg("dim", footerText), safeWidth)];
	}

	private phaseDescription(): string {
		const label = this.activePhase.replaceAll("_", " ");
		const description = label.charAt(0).toUpperCase() + label.slice(1);
		if (this.activeVariant && this.activePhase !== "prepare_variant") return `Variant ${this.activeVariant}: ${description}`;
		return `Setup: ${description}`;
	}

	private variantLines(width: number): string[] {
		const entries = [...this.statuses.entries()];
		const activeIndex = Math.max(0, entries.findIndex(([id]) => id === this.activeVariant));
		const start = Math.max(0, Math.min(activeIndex - 3, entries.length - 8));
		return entries.slice(start, start + 8).map(([id, status]) => {
			const active = id === this.activeVariant ? this.theme.fg("accent", "›") : " ";
			const color = status === "completed" ? "success" : status === "harness_error" ? "error" : status === "running" ? "accent" : status === "policy_finding" ? "warning" : "muted";
			const detail = this.variantPhaseDescription(status, this.variantPhases.get(id));
			const duration = this.variantDuration(id, status);
			return truncateToWidth(`${active} ${this.theme.fg(color, statusGlyph[status] ?? "•")} ${id}  ${status.replaceAll("_", " ")}${detail ? ` — ${detail}` : ""}${duration ? ` • ${duration}` : ""}`, width);
		});
	}

	private variantDuration(id: string, status: MonitorVariantStatus): string | undefined {
		const startedAt = this.variantStartedAt.get(id);
		if (!startedAt) return undefined;
		const finishedAt = this.variantFinishedAt.get(id);
		const seconds = ((finishedAt ?? Date.now()) - startedAt) / 1000;
		return `${finishedAt ? "Completed" : "Running"}: ${seconds.toFixed(1)} seconds`;
	}

	private eventTime(event: MonitorEvent): number {
		const timestamp = Date.parse(event.timestamp);
		return Number.isNaN(timestamp) ? Date.now() : timestamp;
	}

	private variantPhaseDescription(status: MonitorVariantStatus, phase?: ExecutionPhase): string | undefined {
		if (phase === "prompt") return status === "completed" ? "agent finished" : "agent working";
		if (phase === "capture_git_evidence") return "agent finished • saving Git evidence";
		if (phase === "capture_session_evidence") return "agent finished • saving session evidence";
		if (phase === "teardown") return "agent finished • tearing down";
		if (phase === "load_resources") return "loading resources";
		if (phase === "create_session") return "creating session";
		if (phase === "bind_extensions") return "binding extensions";
		if (phase === "resolve_model") return "resolving model";
		return undefined;
	}

	private renderTranscript(width: number): string[] {
		const lines: string[] = [];
		for (const component of this.transcript) {
			try { lines.push(...component.render(width)); }
			catch (error) { lines.push(this.theme.fg("error", `Renderer error: ${error instanceof Error ? error.message : String(error)}`)); }
		}
		return lines;
	}

	invalidate(): void {
		for (const component of this.transcript) component.invalidate();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearInterval(this.ticker);
	}
}
