import { describe, expect, it } from "vitest";
import usageExtension from "../extensions/usage/index.ts";

describe("usage tags", () => {
	it("updates the mutable tags in the session-scoped usage object", async () => {
		let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
		const entries: Array<{ type: string; data: unknown }> = [];
		const notices: Array<{ text: string; level: string }> = [];
		usageExtension({
			on: () => {},
			registerCommand: (_name: string, command: any) => { handler = command.handler; },
			appendEntry: (type: string, data: unknown) => { entries.push({ type, data }); },
		} as any);
		const ctx = {
			sessionManager: { getBranch: () => [], getSessionId: () => "session-1", getSessionFile: () => null },
			ui: { notify: (text: string, level: string) => notices.push({ text, level }) },
		};

		await handler!("tag implementation, planning", ctx);
		expect(entries.at(-1)).toMatchObject({ type: "usage-session", data: { version: 1, sessionId: "session-1", tags: ["implementation", "planning"] } });

		await handler!("tag implementation", ctx);
		expect(entries.at(-1)).toMatchObject({ type: "usage-session", data: { version: 1, sessionId: "session-1", tags: ["implementation", "planning"] } });

		await handler!("tag --remove implementation", ctx);
		expect(entries.at(-1)).toMatchObject({ type: "usage-session", data: { version: 1, sessionId: "session-1", tags: ["planning"] } });

		await handler!("tag --list", ctx);
		expect(notices.at(-1)).toMatchObject({ text: "Active usage tags: planning", level: "info" });

		await handler!("tag --clear", ctx);
		expect(entries.at(-1)).toMatchObject({ type: "usage-session", data: { version: 1, sessionId: "session-1", tags: [] } });
	});
});
