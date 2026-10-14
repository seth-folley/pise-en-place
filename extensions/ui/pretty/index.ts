import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PrettyRegistry, type Formatter } from "./registry.ts";
import { xcodeRenderers, type XcodeKind } from "./xcode.ts";

export const FORMATTERS: readonly (Formatter & { kind: XcodeKind })[] = [
	{ id: "xcode-build", group: "xcode", description: "Reported build results and issues", kind: "build", toolName: "mcp__xcode__BuildProject" },
	{ id: "xcode-log", group: "xcode", description: "Returned build-log diagnostics", kind: "log", toolName: "mcp__xcode__GetBuildLog" },
	{ id: "xcode-issues", group: "xcode", description: "Live file-diagnostic summaries", kind: "issues", toolName: "mcp__xcode__XcodeRefreshCodeIssuesInFile" },
];
const usage = "Usage: /pretty [list] | /pretty [xcode|xcode-build|xcode-log|xcode-issues] on|off | /pretty on|off\nSession only; no settings writes. /pretty --help shows this help.";

export default function (pi: ExtensionAPI) {
	// Keep the package's existing peer floor; older hosts retain their original views.
	if (typeof pi.registerToolRenderer !== "function") return;
	const registry = new PrettyRegistry(FORMATTERS);
	pi.registerToolRenderer((name, next) => {
		const index = FORMATTERS.findIndex(formatter => formatter.toolName === name);
		if (index === -1) return next();
		const base = next();
		// Don't change the framing contract of another extension's self-rendered tool.
		if (base?.renderShell === "self") return base;
		return xcodeRenderers(FORMATTERS[index].kind, FORMATTERS[index].id, registry, base);
	});
	pi.on("session_start", () => registry.reset());
	pi.registerCommand("pretty", {
		description: "Show or toggle package output formatters for this session",
		getArgumentCompletions: prefix => {
			const words = prefix.trimStart().split(/\s+/);
			const targets = ["xcode", ...FORMATTERS.map(f => f.id)];
			const candidates = words.length === 1 ? [...targets, "list", "on", "off", "--help"] : words.length === 2 && targets.includes(words[0]) ? ["on", "off"] : [];
			const typed = words.at(-1) ?? "";
			const lead = words.length === 2 ? `${words[0]} ` : "";
			const matches = candidates.filter(value => value.startsWith(typed)).map(value => ({ value: lead + value, label: value }));
			return matches.length ? matches : null;
		},
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input || input === "list") { ctx.ui.notify(registry.status(), "info"); return; }
			if (["--help", "-h"].includes(input)) { ctx.ui.notify(usage, "info"); return; }
			const words = input.split(/\s+/);
			const target = words.length === 2 ? words[0] : undefined;
			const action = words.at(-1);
			if (words.length > 2 || !["on", "off"].includes(action ?? "") || !registry.set(target, action === "on")) {
				ctx.ui.notify(usage, "warning"); return;
			}
			ctx.ui.notify(registry.status(), "info");
		},
	});
}
