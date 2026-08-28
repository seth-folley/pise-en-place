import os from "node:os";
import path from "node:path";

export function normalizeCommandPathInput(input: string): string {
	const trimmed = input.trim();
	if (trimmed.length < 2) return trimmed;
	const first = trimmed[0];
	return (first === "\"" || first === "'") && trimmed.endsWith(first)
		? trimmed.slice(1, -1)
		: trimmed;
}

export function expandHomePath(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
	return value;
}

export function resolveCommandPath(input: string, cwd: string): string {
	const expanded = expandHomePath(normalizeCommandPathInput(input));
	return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
}
