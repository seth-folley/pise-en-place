import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

type MarkdownOutputDetails = {
	path?: string;
	error?: string;
};

function parsePath(args: string): string | undefined {
	const trimmed = args.trim();
	if (!trimmed) return undefined;

	const quoted = trimmed.match(/^(["'])(.*)\1$/);
	return quoted ? quoted[2] : trimmed;
}

function expandHome(filePath: string): string {
	if (filePath === "~") return homedir();
	if (filePath.startsWith("~/")) return resolve(homedir(), filePath.slice(2));
	return filePath;
}

function resolveMarkdownPath(filePath: string, cwd: string): string {
	const expanded = expandHome(filePath);
	return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function isMarkdownPath(filePath: string): boolean {
	return /\.(md|markdown)$/i.test(filePath);
}

function sendMarkdownMessage(pi: ExtensionAPI, content: string, details: MarkdownOutputDetails) {
	pi.sendMessage({
		customType: "markdown-output",
		content,
		display: true,
		details,
	});
}

export default function markdownOutputExtension(pi: ExtensionAPI) {
	pi.registerCommand("md", {
		description: "Display the contents of a markdown file. Usage: /md <path>",
		handler: async (args, ctx) => {
			const rawPath = parsePath(args);
			if (!rawPath) {
				sendMarkdownMessage(pi, "Usage: /md <path-to-markdown-file>", {
					error: "Missing path.",
				});
				return;
			}

			const filePath = resolveMarkdownPath(rawPath, ctx.cwd);
			if (!isMarkdownPath(filePath)) {
				sendMarkdownMessage(pi, `Not a markdown file: ${filePath}`, {
					path: filePath,
					error: "Expected a .md or .markdown file.",
				});
				return;
			}

			try {
				const content = await readFile(filePath, "utf8");
				sendMarkdownMessage(pi, content, { path: filePath });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendMarkdownMessage(pi, `Unable to read markdown file: ${filePath}\n\n${message}`, {
					path: filePath,
					error: message,
				});
			}
		},
	});
}
