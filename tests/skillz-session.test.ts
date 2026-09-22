import { describe, expect, it } from "vitest";
import contextExtension from "../extensions/productivity/context.ts";
import updateAgentSkillsExtension from "../extensions/skills/update-agent-skills.ts";
import {
	isSkillBlockingDisabled,
	skillBlockingSessionChangedEvent,
	type SkillBlockingSessionChanged,
} from "../src/shared/skill-blocking-session.ts";

describe("/skillz session", () => {
	it("emits disable and enable changes for the active session", async () => {
		let command: ((args: string, ctx: any) => Promise<void>) | undefined;
		const messages: string[] = [];
		const widgets: Array<string[] | undefined> = [];
		const changes: SkillBlockingSessionChanged[] = [];
		updateAgentSkillsExtension({
			registerMessageRenderer() {},
			registerCommand(_name: string, definition: { handler: typeof command }) {
				command = definition.handler;
			},
			on() {},
			events: {
				emit(name: string, change: SkillBlockingSessionChanged) {
					if (name === skillBlockingSessionChangedEvent) changes.push(change);
				},
			},
			sendMessage(message: { content: string }) { messages.push(message.content); },
		} as any);

		const sessionManager = {};
		const ctx = {
			sessionManager,
			cwd: "/tmp",
			hasUI: false,
			ui: { setWidget: (_id: string, content: string[] | undefined) => widgets.push(content) },
		};

		await command!("session --disable", ctx);
		expect(changes.at(-1)).toEqual({ sessionManager, disabled: true });
		expect(messages.at(-1)).toContain("Disabled for this session");
		expect(widgets.at(-1)).toEqual(["skillz: blocking off"]);

		await command!("session --enable", ctx);
		expect(changes.at(-1)).toEqual({ sessionManager, disabled: false });
		expect(messages.at(-1)).toContain("blocked again");
		expect(widgets.at(-1)).toBeUndefined();
	});

	it("updates the context guard's local state through the event bus and resets on reload", async () => {
		const eventHandlers = new Map<string, (payload: any) => void>();
		let sessionStart: ((event: { reason: string }, ctx: any) => Promise<void>) | undefined;
		contextExtension({
			events: { on: (name: string, handler: (payload: any) => void) => eventHandlers.set(name, handler) },
			on(name: string, handler: typeof sessionStart) {
				if (name === "session_start") sessionStart = handler;
			},
			registerCommand() {},
		} as any);

		const sessionManager = {};
		eventHandlers.get(skillBlockingSessionChangedEvent)!({ sessionManager, disabled: true });
		expect(isSkillBlockingDisabled(sessionManager)).toBe(true);

		await sessionStart!({ reason: "reload" }, { sessionManager, cwd: "/tmp" });
		expect(isSkillBlockingDisabled(sessionManager)).toBe(false);
	});
});
