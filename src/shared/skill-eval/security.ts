const secretName = /(api[_-]?key|token|secret|password|authorization|cookie|credential)/i;
const tokenPattern = /\b(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{12,}\b/g;

export function redactText(value: string, roots: string[] = []): string {
	let result = value.replace(tokenPattern, "[REDACTED_TOKEN]").replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
	for (const [name, secret] of Object.entries(process.env)) if (secret && secret.length >= 6 && secretName.test(name)) result = result.replaceAll(secret, `[REDACTED_${name}]`);
	for (const [index, root] of roots.entries()) if (root) result = result.replaceAll(root, index === 0 ? "<workspace>" : "<private-root>");
	return result;
}

export function redactValue(value: unknown, roots: string[] = [], key = ""): unknown {
	if (secretName.test(key)) return "[REDACTED]";
	if (typeof value === "string") return redactText(value, roots);
	if (Array.isArray(value)) return value.map((item) => redactValue(item, roots));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactValue(child, roots, childKey)]));
	return value;
}
