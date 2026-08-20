import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";

const dangerous = [
	/\bgit\s+push\b/i,
	/\bgit\s+remote\s+(add|set-url|remove|rename)\b/i,
	/\brm\s+-[^\n]*r[^\n]*f\s+(\/|~|\$HOME)\b/i,
	/\b(?:sudo|su)\b/i,
	/\b(?:shutdown|reboot|halt|launchctl|systemctl)\b/i,
	/\b(?:ssh|scp|nc|ncat|telnet)\b/i,
	/>\s*\/(?!dev\/null)/,
];
const networkCommands = /\b(?:curl|wget)\b/i;

function inside(value: string, root: string): boolean {
	const absolute = path.resolve(root, value); return absolute === root || absolute.startsWith(`${root}${path.sep}`);
}

export default function evaluationGuard(pi: ExtensionAPI) {
	const workspace = path.resolve(process.env.PI_EVAL_WORKSPACE ?? process.cwd());
	const skillRoot = process.env.PI_EVAL_SKILL_ROOT ? path.resolve(process.env.PI_EVAL_SKILL_ROOT) : undefined;
	const network = process.env.PI_EVAL_NETWORK === "1";
	const readOnly = process.env.PI_EVAL_MODE === "read-only";
	pi.on("tool_call", async (event) => {
		const input = event.input as Record<string, unknown>;
		if (readOnly && (event.toolName === "edit" || event.toolName === "write")) return { block: true, reason: "Evaluation guard: scenario is read-only", terminate: false };
		for (const key of ["path", "file", "directory", "cwd"]) {
			const value = input[key];
			if (typeof value !== "string") continue;
			const absolute = path.resolve(workspace, value); const inWorkspace = inside(value, workspace); const inSkill = skillRoot ? absolute === skillRoot || absolute.startsWith(`${skillRoot}${path.sep}`) : false;
			if (!inWorkspace && !inSkill) return { block: true, reason: `Evaluation guard: ${key} escapes the workspace`, terminate: false };
			if (inSkill && !["read", "grep", "find", "ls"].includes(event.toolName)) return { block: true, reason: "Evaluation guard: frozen skill inputs are read-only", terminate: false };
		}
		if (event.toolName !== "bash") return;
		const command = typeof input.command === "string" ? input.command : "";
		if (readOnly && /(?:^|[;&|]\s*)(?:rm|mv|cp|touch|mkdir|rmdir|truncate)\b|(?:^|\s)sed\s+-i\b|(?<![<>])>(?!>)/.test(command)) return { block: true, reason: "Evaluation guard: write-capable shell command blocked in read-only mode", terminate: false };
		if (/(?:^|[;&|]\s*)(?:env|printenv|set|export)\b|(?:^|[\s'"=])(?:~\/|\$\{?HOME\}?|\.\.\/|\/(?!dev\/null\b))/.test(command)) return { block: true, reason: "Evaluation guard: shell environment or path escape blocked", terminate: false };
		if (dangerous.some((pattern) => pattern.test(command)) || (!network && networkCommands.test(command))) return { block: true, reason: "Evaluation guard: dangerous, remote, or host-mutating command blocked", terminate: false };
		if (!network && /\b(?:npm|pnpm|yarn|pip|gem|cargo|go)\s+(?:install|add|get|fetch)|\bgit\s+(?:clone|fetch|pull)|\bbrew\s+install\b/i.test(command)) return { block: true, reason: "Evaluation guard: network-capable dependency command blocked", terminate: false };
		if (/(^|[;&|]\s*)cd\s+(?:\/|~|\.\.)/.test(command)) return { block: true, reason: "Evaluation guard: shell directory escape blocked", terminate: false };
	});
}
