import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";

export class InteractionBlockedError extends Error {
	constructor() {
		super("A child extension requested custom UI that cannot be safely auto-rejected");
		this.name = "InteractionBlockedError";
	}
}

export interface ChildUIHooks {
	onRequest(kind: string, detail: unknown): void;
	onResponse(kind: string, result: unknown, waitMs: number): void;
	onBlocked(kind: string): void;
	onWaitStart(): void;
	onWaitEnd(waitMs: number): void;
}

/**
 * Child extensions receive only transient dialogs. Persistent setters are intentionally
 * isolated so a completed eval cannot alter the parent session's editor, footer, or theme.
 */
export function createChildUI(
	parent: ExtensionUIContext,
	policy: "interactive" | "auto-reject",
	hooks: ChildUIHooks,
	evaluationSignal?: AbortSignal,
): ExtensionUIContext {
	const dialogOptions = (opts?: ExtensionUIDialogOptions): ExtensionUIDialogOptions | undefined => {
		if (!evaluationSignal) return opts;
		const signals = [evaluationSignal, opts?.signal].filter((item): item is AbortSignal => item !== undefined);
		return { ...opts, signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) };
	};
	async function dialog<T>(kind: string, detail: unknown, rejected: T, invoke: () => Promise<T>): Promise<T> {
		hooks.onRequest(kind, detail);
		if (policy === "auto-reject") {
			hooks.onResponse(kind, rejected, 0);
			return rejected;
		}
		const started = Date.now();
		hooks.onWaitStart();
		try {
			const result = await invoke();
			hooks.onResponse(kind, result, Date.now() - started);
			return result;
		} finally {
			hooks.onWaitEnd(Date.now() - started);
		}
	}

	const custom: ExtensionUIContext["custom"] = async <T>(factory: Parameters<ExtensionUIContext["custom"]>[0], options: Parameters<ExtensionUIContext["custom"]>[1]): Promise<T> => {
		hooks.onRequest("custom", { overlay: options?.overlay ?? false });
		if (policy === "auto-reject") {
			hooks.onBlocked("custom");
			throw new InteractionBlockedError();
		}
		const started = Date.now();
		hooks.onWaitStart();
		try {
			const result = await parent.custom(factory, options);
			hooks.onResponse("custom", "completed", Date.now() - started);
			return result as T;
		} finally {
			hooks.onWaitEnd(Date.now() - started);
		}
	};

	return {
		select: (title, options, opts) => dialog("select", { title, options }, undefined, () => parent.select(title, options, dialogOptions(opts))),
		confirm: (title, message, opts) => dialog("confirm", { title, message }, false, () => parent.confirm(title, message, dialogOptions(opts))),
		input: (title, placeholder, opts) => dialog("input", { title, placeholder }, undefined, () => parent.input(title, placeholder, dialogOptions(opts))),
		editor: (title, prefill) => dialog("editor", { title }, undefined, () => parent.editor(title, prefill)),
		custom,
		notify: (message, type) => hooks.onRequest("notification", { message, type }),
		onTerminalInput: () => () => {},
		setStatus: (key, text) => hooks.onRequest("status", { key, text }),
		setWorkingMessage: (message) => hooks.onRequest("working_message", { message }),
		setWorkingVisible: (visible) => hooks.onRequest("working_visible", { visible }),
		setWorkingIndicator: (options) => hooks.onRequest("working_indicator", { options }),
		setHiddenThinkingLabel: (label) => hooks.onRequest("hidden_thinking_label", { label }),
		setWidget: (key) => hooks.onRequest("suppressed_widget", { key }),
		setFooter: () => hooks.onRequest("suppressed_footer", {}),
		setHeader: () => hooks.onRequest("suppressed_header", {}),
		setTitle: (title) => hooks.onRequest("suppressed_title", { title }),
		pasteToEditor: () => hooks.onRequest("suppressed_editor_mutation", { operation: "paste" }),
		setEditorText: () => hooks.onRequest("suppressed_editor_mutation", { operation: "set" }),
		getEditorText: () => "",
		addAutocompleteProvider: () => hooks.onRequest("suppressed_autocomplete", {}),
		setEditorComponent: () => hooks.onRequest("suppressed_editor_component", {}),
		getEditorComponent: () => undefined,
		get theme() { return parent.theme; },
		getAllThemes: () => parent.getAllThemes(),
		getTheme: (name) => parent.getTheme(name),
		setTheme: () => ({ success: false, error: "Child sessions cannot change the parent theme" }),
		getToolsExpanded: () => parent.getToolsExpanded(),
		setToolsExpanded: () => hooks.onRequest("suppressed_tool_expansion", {}),
	};
}
