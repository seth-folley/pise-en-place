/** Pi tool allowlists use exact names and `*` (not shell ?/[] patterns). */
export function toolNameMatcher(entries: readonly string[]): (name: string) => boolean {
	const patterns = entries.map(entry => new RegExp(`^${entry.trim().split("*")
		.map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`));
	return name => patterns.some(pattern => pattern.test(name));
}

export function mcpNamespace(name: string): string {
	return `mcp__${name.replace(/-/g, "_")}`;
}

/** Can a literal namespace prefix be completed to a name matching this glob?
 * Tool names aren't known until connection. Connect only potential owners, never all servers
 * followed by filtering. This also handles server/tool names containing double underscores.
 */
function matchesPrefix(pattern: string, prefix: string): boolean {
	const close = (states: Set<number>): Set<number> => {
		for (const index of states) if (pattern[index] === "*") states.add(index + 1);
		return states;
	};
	let states = close(new Set([0]));
	for (const character of prefix) {
		const next = new Set<number>();
		for (const index of states) {
			if (pattern[index] === "*") next.add(index);
			else if (pattern[index] === character) next.add(index + 1);
		}
		states = close(next);
	}
	return [...states].some(index => index < pattern.length); // Nonempty tool suffix.
}

export function mcpToolPatterns(entries: readonly string[] | undefined): string[] {
	return (entries ?? []).map(entry => entry.trim()).filter(entry => entry.startsWith("mcp__"));
}

export function selectsMcpServer(patterns: readonly string[], name: string): boolean {
	return patterns.some(pattern => matchesPrefix(pattern, `${mcpNamespace(name)}__`));
}
