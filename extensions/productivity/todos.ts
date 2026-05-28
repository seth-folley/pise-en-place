/*
 * Session todo list extension.
 *
 * Adds a branch-aware todo list shared by the user and agent:
 * - Agent tool: todo
 * - User command: /todos
 * - TUI widget above the editor
 *
 * State is reconstructed from the active session branch. Agent tool mutations are
 * stored in tool result details; user command mutations are stored as custom
 * session entries via pi.appendEntry().
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type TodoAction = "list" | "add" | "done" | "undone" | "toggle" | "edit" | "remove" | "clear";

type Todo = {
	id: number;
	text: string;
	done: boolean;
};

type TodoStateDetails = {
	version: 1;
	action: TodoAction;
	todos: Todo[];
	nextId: number;
	error?: string;
};

type TodoCommandAction = TodoAction | "help" | "toggle-ui";

type ParsedTodoCommand = {
	action: TodoCommandAction;
	id?: number;
	text?: string;
	error?: string;
};

const todoWidgetId = "session-todos";
const todoCustomType = "todo-state";

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "done", "undone", "toggle", "edit", "remove", "clear"] as const),
	id: Type.Optional(Type.Number({ description: "Todo ID for done, undone, toggle, edit, or remove" })),
	text: Type.Optional(Type.String({ description: "Todo text for add or edit" })),
});

function cloneTodos(todos: Todo[]): Todo[] {
	return todos.map((todo) => ({ ...todo }));
}

function makeDetails(action: TodoAction, todos: Todo[], nextId: number, error?: string): TodoStateDetails {
	return { version: 1, action, todos: cloneTodos(todos), nextId, error };
}

function formatTodoList(todos: Todo[]): string {
	if (!todos.length) return "No todos.";
	return todos.map((todo) => `[${todo.done ? "x" : " "}] #${todo.id}: ${todo.text}`).join("\n");
}

function tokenizeArgs(args: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let escaping = false;

	for (const char of args) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}

		if (char === "\\" && quote !== "'") {
			escaping = true;
			continue;
		}

		if ((char === '"' || char === "'") && !quote) {
			quote = char;
			continue;
		}

		if (quote === char) {
			quote = null;
			continue;
		}

		if (!quote && /\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (current) tokens.push(current);
	return tokens;
}

function parseId(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const normalized = value.startsWith("#") ? value.slice(1) : value;
	const id = Number(normalized);
	return Number.isInteger(id) && id > 0 ? id : undefined;
}

function parseTodosCommand(args: string): ParsedTodoCommand {
	const tokens = tokenizeArgs(args.trim());
	const [command, ...rest] = tokens;

	if (!command) return { action: "toggle-ui" };
	if (command === "help" || command === "-h" || command === "--help") return { action: "help" };
	if (command === "list") return { action: "list" };
	if (command === "show" || command === "hide" || command === "toggle-ui") return { action: "toggle-ui", text: command };
	if (command === "clear") return { action: "clear" };

	if (command === "add") {
		const text = rest.join(" ").trim();
		return text ? { action: "add", text } : { action: "add", error: "Usage: /todos add <text>" };
	}

	if (["done", "undone", "toggle", "remove"].includes(command)) {
		const id = parseId(rest[0]);
		return id ? { action: command as TodoAction, id } : { action: command as TodoAction, error: `Usage: /todos ${command} <id>` };
	}

	if (command === "edit") {
		const id = parseId(rest[0]);
		const text = rest.slice(1).join(" ").trim();
		if (!id || !text) return { action: "edit", error: "Usage: /todos edit <id> <text>" };
		return { action: "edit", id, text };
	}

	return { action: "help", error: `Unknown /todos command: ${command}` };
}

function helpText(): string {
	return [
		"Todo commands",
		"/todos                      Toggle the todo widget when todos exist",
		"/todos list                 Print todos",
		"/todos show                 Show the todo widget",
		"/todos hide                 Hide the todo widget",
		"/todos toggle-ui            Toggle the todo widget",
		"/todos add <text>           Add a todo",
		"/todos done <id>            Mark done",
		"/todos undone <id>          Mark not done",
		"/todos toggle <id>          Toggle done state",
		"/todos edit <id> <text>     Replace todo text",
		"/todos remove <id>          Remove a todo",
		"/todos clear                Clear all todos",
	].join("\n");
}

export default function todosExtension(pi: ExtensionAPI) {
	let todos: Todo[] = [];
	let nextId = 1;
	let widgetVisible = true;

	function updateWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		if (!todos.length || !widgetVisible) {
			ctx.ui.setWidget(todoWidgetId, undefined);
			return;
		}

		ctx.ui.setWidget(todoWidgetId, (_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				const done = todos.filter((todo) => todo.done).length;
				const openTodos = todos.filter((todo) => !todo.done);
				const title = theme.fg("accent", `Todos: ${done}/${todos.length} done`);

				const lines = [truncateToWidth(title, width)];
				for (const todo of openTodos.slice(0, 5)) {
					lines.push(truncateToWidth(`${theme.fg("dim", "○")} ${theme.fg("accent", `#${todo.id}`)} ${todo.text}`, width));
				}

				const hiddenOpen = Math.max(0, openTodos.length - 5);
				if (hiddenOpen) lines.push(truncateToWidth(theme.fg("dim", `… ${hiddenOpen} more open`), width));
				return lines;
			},
		}));
	}

	function applyState(details: TodoStateDetails): void {
		todos = cloneTodos(details.todos);
		nextId = details.nextId;
	}

	function reconstructState(ctx: ExtensionContext): void {
		todos = [];
		nextId = 1;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message") {
				const message = entry.message;
				if (message.role === "toolResult" && message.toolName === "todo") {
					const details = message.details as TodoStateDetails | undefined;
					if (details?.version === 1) applyState(details);
				}
				continue;
			}

			if (entry.type === "custom" && entry.customType === todoCustomType) {
				const details = entry.data as TodoStateDetails | undefined;
				if (details?.version === 1) applyState(details);
			}
		}
	}

	function mutate(action: TodoAction, params: { id?: number; text?: string }): { message: string; details: TodoStateDetails } {
		switch (action) {
			case "list":
				return { message: formatTodoList(todos), details: makeDetails(action, todos, nextId) };

			case "add": {
				const text = params.text?.trim();
				if (!text) return { message: "Error: text required for add", details: makeDetails(action, todos, nextId, "text required") };
				const todo: Todo = { id: nextId++, text, done: false };
				todos.push(todo);
				return { message: `Added todo #${todo.id}: ${todo.text}`, details: makeDetails(action, todos, nextId) };
			}

			case "done":
			case "undone":
			case "toggle":
			case "edit":
			case "remove": {
				if (params.id === undefined) return { message: `Error: id required for ${action}`, details: makeDetails(action, todos, nextId, "id required") };
				const index = todos.findIndex((todo) => todo.id === params.id);
				if (index === -1) return { message: `Todo #${params.id} not found`, details: makeDetails(action, todos, nextId, `#${params.id} not found`) };

				const todo = todos[index]!;
				if (action === "done") {
					todo.done = true;
					return { message: `Todo #${todo.id} completed`, details: makeDetails(action, todos, nextId) };
				}
				if (action === "undone") {
					todo.done = false;
					return { message: `Todo #${todo.id} marked not done`, details: makeDetails(action, todos, nextId) };
				}
				if (action === "toggle") {
					todo.done = !todo.done;
					return { message: `Todo #${todo.id} ${todo.done ? "completed" : "marked not done"}`, details: makeDetails(action, todos, nextId) };
				}
				if (action === "edit") {
					const text = params.text?.trim();
					if (!text) return { message: "Error: text required for edit", details: makeDetails(action, todos, nextId, "text required") };
					todo.text = text;
					return { message: `Updated todo #${todo.id}: ${todo.text}`, details: makeDetails(action, todos, nextId) };
				}

				todos.splice(index, 1);
				return { message: `Removed todo #${todo.id}: ${todo.text}`, details: makeDetails(action, todos, nextId) };
			}

			case "clear": {
				const count = todos.length;
				todos = [];
				nextId = 1;
				return { message: `Cleared ${count} todo${count === 1 ? "" : "s"}`, details: makeDetails(action, todos, nextId) };
			}
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		updateWidget(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
		updateWidget(ctx);
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Manage the session-scoped todo list shown in the TUI. Actions: list, add, done, undone, toggle, edit, remove, clear.",
		promptSnippet: "Manage the shared session todo list visible in the TUI",
		promptGuidelines: [
			"Use the todo tool to track multi-step work, mark items done as they are completed, and keep the visible todo widget current.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { message, details } = mutate(params.action, { id: params.id, text: params.text });
			updateWidget(ctx);
			return { content: [{ type: "text", text: message }], details };
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action ?? "");
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.text) text += ` ${theme.fg("dim", `\"${args.text}\"`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TodoStateDetails | undefined;
			if (!details) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "", 0, 0);
			}

			if (details.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			if (!details.todos.length) return new Text(theme.fg("dim", "No todos"), 0, 0);

			const done = details.todos.filter((todo) => todo.done).length;
			let text = theme.fg("muted", `${done}/${details.todos.length} done`);
			const display = expanded ? details.todos : details.todos.slice(0, 5);
			for (const todo of display) {
				const check = todo.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
				const body = todo.done ? theme.fg("dim", todo.text) : theme.fg("muted", todo.text);
				text += `\n${check} ${theme.fg("accent", `#${todo.id}`)} ${body}`;
			}
			if (!expanded && details.todos.length > 5) text += `\n${theme.fg("dim", `… ${details.todos.length - 5} more`)}`;
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Manage the shared session todo list",
		handler: async (args, ctx) => {
			const parsed = parseTodosCommand(args);
			if (parsed.error) ctx.ui.notify(parsed.error, "error");
			if (parsed.action === "help" || parsed.error) {
				ctx.ui.notify(helpText(), parsed.error ? "error" : "info");
				return;
			}

			if (parsed.action === "toggle-ui") {
				if (!todos.length) {
					widgetVisible = false;
					updateWidget(ctx);
					ctx.ui.notify("No todos yet. Add one with /todos add <text>.", "info");
					return;
				}

				if (parsed.text === "show") widgetVisible = true;
				else if (parsed.text === "hide") widgetVisible = false;
				else widgetVisible = !widgetVisible;

				updateWidget(ctx);
				ctx.ui.notify(widgetVisible ? "Todo widget shown" : "Todos hidden. Use /todos to show", "info");
				return;
			}

			const { message, details } = mutate(parsed.action, { id: parsed.id, text: parsed.text });
			if (parsed.action !== "list") pi.appendEntry(todoCustomType, details);
			if (parsed.action === "add") widgetVisible = true;
			updateWidget(ctx);
			ctx.ui.notify(message, details.error ? "error" : "info");
		},
	});
}
