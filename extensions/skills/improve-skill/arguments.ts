import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, resolve } from "node:path";

export type ImproveSkillArguments =
	| { help: true }
	| {
		help: false;
		skillArgument: string;
		focus?: string;
		promptPath?: string;
		showPrompt: boolean;
	};

const usage = "Usage: /skill-review <skill-name-or-absolute-path> [--focus \"text\"] [--prompt <markdown-file>] [--show-prompt]";

export function skillReviewHelpText(): string {
	return [
		"Skill review",
		"",
		usage,
		"",
		"Options:",
		"  --focus \"text\"       Append additional criteria to every reviewer prompt.",
		"  --prompt <file.md>    Replace the built-in prompt with a Markdown file.",
		"  --show-prompt         Preview the composed reviewer prompts without launching.",
		"  -h, --help            Show this help.",
		"",
		"Agent tool: skill_review_prompt returns the exact composed prompts without launching reviewers.",
		"Reviews run in Pi, Codex, and Claude, are consolidated automatically, and are retained under ~/.pi/agent/skill-reviews/.",
	].join("\n");
}

export function tokenizeArguments(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;
	let started = false;

	for (const character of input) {
		if (escaping) {
			current += character;
			escaping = false;
			started = true;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaping = true;
			started = true;
			continue;
		}
		if ((character === "'" || character === '"') && !quote) {
			quote = character;
			started = true;
			continue;
		}
		if (character === quote) {
			quote = undefined;
			continue;
		}
		if (!quote && /\s/.test(character)) {
			if (started) {
				tokens.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += character;
		started = true;
	}

	if (escaping) throw new Error("The command ends with an incomplete escape sequence.");
	if (quote) throw new Error("The command contains an unterminated quoted value.");
	if (started) tokens.push(current);
	return tokens;
}

function optionValue(tokens: string[], index: number, option: string): { value: string; nextIndex: number } {
	const token = tokens[index]!;
	const inlinePrefix = `${option}=`;
	if (token.startsWith(inlinePrefix)) {
		const value = token.slice(inlinePrefix.length);
		if (!value) throw new Error(`${option} requires a non-empty value.`);
		return { value, nextIndex: index };
	}
	const value = tokens[index + 1];
	if (value === undefined) throw new Error(`${option} requires a value.`);
	return { value, nextIndex: index + 1 };
}

export function parseImproveSkillArguments(input: string): ImproveSkillArguments {
	const tokens = tokenizeArguments(input);
	const helpOptions = tokens.filter((token) => token === "--help" || token === "-h");
	if (helpOptions.length > 0) {
		if (tokens.length !== 1) throw new Error(`${helpOptions[0]} cannot be combined with other arguments.`);
		return { help: true };
	}

	let skillArgument: string | undefined;
	let focus: string | undefined;
	let promptPath: string | undefined;
	let showPrompt = false;

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token === "--show-prompt") {
			if (showPrompt) throw new Error("--show-prompt may only be provided once.");
			showPrompt = true;
			continue;
		}
		if (token === "--focus" || token.startsWith("--focus=")) {
			if (focus !== undefined) throw new Error("--focus may only be provided once.");
			const parsed = optionValue(tokens, index, "--focus");
			focus = parsed.value.trim();
			if (!focus) throw new Error("--focus requires a non-empty value.");
			index = parsed.nextIndex;
			continue;
		}
		if (token === "--prompt" || token.startsWith("--prompt=")) {
			if (promptPath !== undefined) throw new Error("--prompt may only be provided once.");
			const parsed = optionValue(tokens, index, "--prompt");
			promptPath = parsed.value;
			index = parsed.nextIndex;
			continue;
		}
		if (token.startsWith("--")) throw new Error(`Unknown option: ${token}`);
		if (skillArgument !== undefined) throw new Error(`Unexpected argument: ${token}\n${usage}`);
		skillArgument = token;
	}

	if (!skillArgument) throw new Error(usage);
	return { help: false, skillArgument, focus, promptPath, showPrompt };
}

function expandHome(filePath: string): string {
	if (filePath === "~") return homedir();
	if (filePath.startsWith("~/")) return resolve(homedir(), filePath.slice(2));
	return filePath;
}

export async function readCustomPrompt(inputPath: string, cwd: string): Promise<{ path: string; content: string }> {
	const expanded = expandHome(inputPath);
	const resolved = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
	if (![".md", ".markdown"].includes(extname(resolved).toLowerCase())) {
		throw new Error(`Custom prompt must be a Markdown file (.md or .markdown): ${resolved}`);
	}

	let canonicalPath: string;
	try {
		canonicalPath = await realpath(resolved);
		const metadata = await stat(canonicalPath);
		if (!metadata.isFile()) throw new Error("not a regular file");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to read custom prompt file: ${resolved} (${message})`);
	}

	const content = await readFile(canonicalPath, "utf8");
	if (!content.trim()) throw new Error(`Custom prompt file is empty: ${canonicalPath}`);
	return { path: canonicalPath, content };
}
