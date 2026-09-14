#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { once } from "node:events";

const PRIVATE_FILE_MODE = 0o600;
const REVIEW_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 2_000;

async function writeJsonAtomic(filePath, value) {
	const partialPath = `${filePath}.${process.pid}.partial`;
	await writeFile(partialPath, `${JSON.stringify(value, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
	await rename(partialPath, filePath);
	await chmod(filePath, PRIVATE_FILE_MODE);
}

async function updateRunManifest(runDir, update) {
	const lockPath = path.join(runDir, ".run-json.lock");
	for (let attempt = 0; ; attempt += 1) {
		try {
			await mkdir(lockPath, { mode: 0o700 });
			break;
		} catch (error) {
			if (error?.code !== "EEXIST" || attempt >= 200) throw error;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	try {
		const manifestPath = path.join(runDir, "run.json");
		const run = await readJson(manifestPath);
		await writeJsonAtomic(manifestPath, update(run));
	} finally {
		await rmdir(lockPath).catch(() => undefined);
	}
}

function consumeCodexOutput(state, chunk, flush = false) {
	state.buffer += chunk;
	const lines = state.buffer.split("\n");
	state.buffer = flush ? "" : lines.pop() ?? "";
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			if (event.type === "thread.started" && typeof event.thread_id === "string") {
				state.sessionId = event.thread_id;
				process.stdout.write(`Codex session: ${event.thread_id}\n`);
			}
			if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
				state.messages.push(event.item.text);
			}
		} catch {
			state.unparsed.push(line);
		}
	}
}

async function findSessionFile(root, sessionId) {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		const entryPath = path.join(root, entry.name);
		if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)) return entryPath;
		if (entry.isDirectory()) {
			const found = await findSessionFile(entryPath, sessionId);
			if (found) return found;
		}
	}
	return undefined;
}

async function nativeSessionMetadata(harness, sessionId) {
	if (!sessionId) return { sessionId: null, sessionFile: null, model: null, provider: null };
	const roots = {
		Pi: process.env.PI_CODING_AGENT_SESSION_DIR || path.join(homedir(), ".pi", "agent", "sessions"),
		Codex: path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "sessions"),
		Claude: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "projects"),
	};
	const sessionFile = await findSessionFile(roots[harness], sessionId);
	let model = null;
	let provider = null;
	if (sessionFile) {
		for (const line of (await readFile(sessionFile, "utf8")).split("\n")) {
			if (!line) continue;
			try {
				const entry = JSON.parse(line);
				if (harness === "Pi" && entry.type === "message" && entry.message?.role === "assistant") {
					model = entry.message.model ?? model;
					provider = entry.message.provider ?? provider;
				}
				if (harness === "Claude" && entry.type === "assistant") model = entry.message?.model ?? model;
				if (harness === "Codex" && entry.type === "session_meta") provider = entry.payload?.model_provider ?? provider;
				if (harness === "Codex" && entry.type === "turn_context") model = entry.payload?.model ?? model;
			} catch {
				// Ignore malformed or partially-written native session lines.
			}
		}
	}
	return { sessionId, sessionFile: sessionFile ?? null, model, provider };
}

async function runCaptured(runDir, artifact, command, args, options = {}) {
	const startedAt = new Date().toISOString();
	const outputPath = path.join(runDir, artifact.output);
	const stderrPath = path.join(runDir, artifact.stderr);
	const statusPath = path.join(runDir, artifact.status);
	const outputPartial = `${outputPath}.partial`;
	const stderrPartial = `${stderrPath}.partial`;
	const output = createWriteStream(outputPartial, { mode: PRIVATE_FILE_MODE });
	const stderr = createWriteStream(stderrPartial, { mode: PRIVATE_FILE_MODE });
	const codexOutput = { buffer: "", messages: [], unparsed: [], sessionId: null };

	let child;
	let spawnError;
	try {
		child = spawn(command, args, { stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"] });
		if (options.stdin !== undefined) {
			child.stdin.on("error", (error) => { spawnError ??= error; });
			child.stdin.end(options.stdin);
		}
	} catch (error) {
		spawnError = error;
	}

	let exitCode = 1;
	let signal = null;
	if (child) {
		child.stdout.on("data", (chunk) => {
			if (options.format === "codex-json") consumeCodexOutput(codexOutput, chunk.toString("utf8"));
			else {
				output.write(chunk);
				process.stdout.write(chunk);
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr.write(chunk);
			process.stderr.write(chunk);
		});
		child.on("error", (error) => {
			spawnError = error;
		});
		for (const signalName of ["SIGHUP", "SIGINT", "SIGTERM"]) {
			process.once(signalName, () => child.kill(signalName));
		}
		const result = await new Promise((resolve) => child.once("close", (code, closeSignal) => resolve([code, closeSignal])));
		exitCode = typeof result[0] === "number" ? result[0] : 1;
		signal = result[1] ?? null;
	}

	if (options.format === "codex-json") {
		consumeCodexOutput(codexOutput, "", true);
		const review = codexOutput.messages.at(-1) ?? codexOutput.unparsed.join("\n");
		if (review) {
			const markdown = `${review.trimEnd()}\n`;
			output.write(markdown);
			process.stdout.write(markdown);
		}
		if (codexOutput.unparsed.length > 0 && codexOutput.messages.length > 0) stderr.write(`Unparsed Codex JSON output:\n${codexOutput.unparsed.join("\n")}\n`);
	}

	if (spawnError) {
		const message = spawnError instanceof Error ? spawnError.message : String(spawnError);
		stderr.write(`${message}\n`);
		process.stderr.write(`${message}\n`);
	}
	const finished = Promise.all([once(output, "finish"), once(stderr, "finish")]);
	output.end();
	stderr.end();
	await finished;
	await Promise.all([rename(outputPartial, outputPath), rename(stderrPartial, stderrPath)]);

	const metadata = await nativeSessionMetadata(options.harness, codexOutput.sessionId ?? artifact.sessionId);
	const status = {
		status: exitCode === 0 && !spawnError ? "complete" : "failed",
		exitCode,
		signal,
		startedAt,
		completedAt: new Date().toISOString(),
		...metadata,
		...(spawnError ? { error: spawnError instanceof Error ? spawnError.message : String(spawnError) } : {}),
	};
	await writeJsonAtomic(statusPath, status);
	if (options.artifactName) {
		await updateRunManifest(runDir, (run) => options.artifactName === "Consolidated"
			? { ...run, consolidated: artifactWithResult(run.consolidated, status) }
			: { ...run, reviewers: { ...run.reviewers, [options.artifactName]: artifactWithResult(run.reviewers[options.artifactName], status) } });
	}
	return status;
}

async function readJson(filePath) {
	return JSON.parse(await readFile(filePath, "utf8"));
}

async function waitForReviewers(runDir, run, interrupted) {
	const deadline = Date.now() + REVIEW_TIMEOUT_MS;
	const pending = new Map(Object.entries(run.reviewers));
	const statuses = {};
	while (pending.size > 0 && Date.now() < deadline && !interrupted()) {
		for (const [reviewer, artifact] of pending) {
			try {
				statuses[reviewer] = await readJson(path.join(runDir, artifact.status));
				pending.delete(reviewer);
			} catch (error) {
				if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
			}
		}
		if (pending.size > 0) await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
	for (const reviewer of pending.keys()) {
		statuses[reviewer] = { status: "timed_out", completedAt: new Date().toISOString() };
	}
	return statuses;
}

function artifactWithResult(artifact, result) {
	return {
		...artifact,
		sessionId: result.sessionId ?? artifact.sessionId ?? null,
		sessionFile: result.sessionFile ?? artifact.sessionFile ?? null,
		model: result.model ?? artifact.model ?? null,
		provider: result.provider ?? artifact.provider ?? null,
		result,
	};
}

function consolidationPrompt(runDir, run, statuses) {
	const reviewLines = Object.entries(run.reviewers).map(([reviewer, artifact]) =>
		`- ${reviewer}: ${path.join(runDir, artifact.output)} (status: ${statuses[reviewer]?.status ?? "unknown"})`,
	);
	return [
		"You are consolidating three independent reviews of a reusable agent skill.",
		`Read the skill at: ${run.skill.directory}`,
		`Review outputs are retained under: ${runDir}`,
		"",
		"Read SKILL.md completely and inspect relevant files owned by the skill. Then read every available reviewer output:",
		...reviewLines,
		"",
		"Synthesize rather than concatenate. Verify findings against the current skill files; reviewer agreement is not proof. Distinguish evidence-backed defects from preferences, identify the source reviewer for material findings, resolve or clearly describe disagreements, and discard duplicates or unsupported claims.",
		"",
		"Return readable Markdown with:",
		"1. Executive summary",
		"2. Consensus strengths and leave-as-is guidance",
		"3. Consolidated findings with skill file references and reviewer attribution",
		"4. Disagreements or rejected claims",
		"5. Prioritized action plan grouped into critical, worthwhile, and optional",
		"",
		"You are strictly read-only: do not modify files, install dependencies, access the network, or ask the user questions.",
	].join("\n");
}

async function consolidate(runDir) {
	const manifestPath = path.join(runDir, "run.json");
	const run = await readJson(manifestPath);
	let interruption;
	const signalHandlers = new Map();
	for (const signalName of ["SIGHUP", "SIGINT", "SIGTERM"]) {
		const handler = () => { interruption ??= signalName; };
		signalHandlers.set(signalName, handler);
		process.once(signalName, handler);
	}

	try {
		const statuses = await waitForReviewers(runDir, run, () => Boolean(interruption));
		if (interruption) throw new Error(`Consolidation interrupted by ${interruption}`);
		await updateRunManifest(runDir, (current) => ({
			...current,
			status: "consolidating",
			reviewers: Object.fromEntries(Object.entries(current.reviewers).map(([name, artifact]) => [name, artifactWithResult(artifact, statuses[name])])),
		}));

		const sessionName = `Skill review consolidation: ${run.skill.name}`.slice(0, 120);
		const prompt = consolidationPrompt(runDir, run, statuses);
		await writeFile(path.join(runDir, run.consolidated.prompt), prompt, { mode: PRIVATE_FILE_MODE });
		const result = await runCaptured(runDir, run.consolidated, "pi", [
			"--print", "--no-extensions", "--no-skills", "--name", sessionName,
			"--session-id", run.consolidated.sessionId, "--tools", "read,grep,find,ls",
		], { harness: "Pi", format: "text", artifactName: "Consolidated", stdin: prompt });
		const reviewerFailed = Object.values(statuses).some((status) => status.status !== "complete");
		await updateRunManifest(runDir, (current) => ({
			...current,
			status: result.status === "complete" && !reviewerFailed ? "complete" : "partial",
			completedAt: new Date().toISOString(),
			consolidated: artifactWithResult(current.consolidated, result),
		}));
		return result.exitCode;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const result = { status: "failed", exitCode: 1, signal: interruption ?? null, completedAt: new Date().toISOString(), error: message };
		await writeJsonAtomic(path.join(runDir, run.consolidated.status), result);
		await updateRunManifest(runDir, (current) => ({
			...current,
			status: "partial",
			completedAt: new Date().toISOString(),
			consolidated: artifactWithResult(current.consolidated, result),
		}));
		console.error(message);
		return 1;
	} finally {
		for (const [signalName, handler] of signalHandlers) process.removeListener(signalName, handler);
	}
}

async function main() {
	const [mode, runDir, artifactName, ...rest] = process.argv.slice(2);
	if (mode === "capture") {
		const separator = rest.indexOf("--");
		if (!runDir || !artifactName || separator < 0 || !rest[separator + 1]) throw new Error("Usage: review-runner.mjs capture <run-dir> <artifact-name> [--format <text|codex-json>] [--stdin-file <path>] -- <command> [args...]");
		const runnerOptions = rest.slice(0, separator);
		const formatIndex = runnerOptions.indexOf("--format");
		const format = formatIndex >= 0 ? runnerOptions[formatIndex + 1] : "text";
		const stdinFileIndex = runnerOptions.indexOf("--stdin-file");
		const stdinFile = stdinFileIndex >= 0 ? runnerOptions[stdinFileIndex + 1] : undefined;
		if (stdinFileIndex >= 0 && stdinFile === undefined) throw new Error("--stdin-file requires a value.");
		const stdin = stdinFile ? await readFile(stdinFile, "utf8") : undefined;
		if (!["text", "codex-json"].includes(format)) throw new Error(`Unsupported capture format: ${format}`);
		const run = await readJson(path.join(runDir, "run.json"));
		const artifact = run.reviewers[artifactName];
		if (!artifact) throw new Error(`Unknown reviewer artifact: ${artifactName}`);
		const result = await runCaptured(runDir, artifact, rest[separator + 1], rest.slice(separator + 2), { harness: artifactName, format, artifactName, stdin });
		return result.exitCode;
	}
	if (mode === "consolidate") {
		if (!runDir) throw new Error("Usage: review-runner.mjs consolidate <run-dir>");
		return consolidate(runDir);
	}
	throw new Error("Usage: review-runner.mjs <capture|consolidate> ...");
}

try {
	process.exitCode = await main();
} catch (error) {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
}
