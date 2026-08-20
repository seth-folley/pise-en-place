import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { FileManifestEntry, FrozenInput } from "./domain.ts";

export interface CommandOutput { code: number; stdout: string; stderr: string; durationMs: number; truncated: boolean }

export async function runCommand(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; signal?: AbortSignal; stdin?: string; maxOutput?: number } = {}): Promise<CommandOutput> {
	const started = Date.now(); const maxOutput = options.maxOutput ?? 8 * 1024 * 1024;
	return await new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
		let stdout = "", stderr = "", settled = false, closed = false, truncated = false;
		const append = (current: string, chunk: Buffer) => { const combined = current + chunk.toString("utf8"); if (Buffer.byteLength(combined) > maxOutput) truncated = true; return combined.slice(-maxOutput); };
		child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); }); child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
		const signalChild = (signal: NodeJS.Signals) => { try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* process already exited */ } };
		const terminate = () => { if (!child.killed) { signalChild("SIGTERM"); setTimeout(() => { if (!closed) signalChild("SIGKILL"); }, 2_000).unref(); } };
		const timer = options.timeout ? setTimeout(() => { terminate(); if (!settled) { settled = true; reject(new Error(`Command timed out after ${options.timeout}ms: ${command}`)); } }, options.timeout) : undefined; timer?.unref();
		const abort = () => { terminate(); if (!settled) { settled = true; reject(new Error(`Command aborted: ${command}`)); } }; options.signal?.addEventListener("abort", abort, { once: true });
		child.on("error", (error) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); options.signal?.removeEventListener("abort", abort); reject(error); });
		child.on("close", (code) => { closed = true; if (settled) return; settled = true; if (timer) clearTimeout(timer); options.signal?.removeEventListener("abort", abort); resolve({ code: code ?? -1, stdout, stderr, durationMs: Date.now() - started, truncated }); });
		if (options.stdin !== undefined) child.stdin.end(options.stdin); else child.stdin.end();
	});
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await (await import("node:fs/promises")).rename(temp, file);
}
export async function readJson<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, "utf8")) as T; }
export async function sha256File(file: string): Promise<string> { return await new Promise((resolve, reject) => { const hash = createHash("sha256"); const stream = createReadStream(file); stream.on("data", (chunk) => hash.update(chunk)); stream.on("error", reject); stream.on("end", () => resolve(hash.digest("hex"))); }); }

export async function manifestDirectory(root: string, options: { includeNodeModules?: boolean; allowDanglingInternalSymlinks?: boolean } = {}): Promise<{ files: FileManifestEntry[]; digest: string }> {
	root = await realpath(root); const files: FileManifestEntry[] = [];
	async function walk(directory: string): Promise<void> {
		const entries = await readdir(directory, { withFileTypes: true }); entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const absolute = path.join(directory, entry.name); const relative = path.relative(root, absolute).split(path.sep).join("/");
			if (entry.isSymbolicLink()) { const link = await readlink(absolute); let target: string | undefined; try { target = await realpath(absolute); } catch { const lexical = path.resolve(path.dirname(absolute), link); if (!options.allowDanglingInternalSymlinks || path.isAbsolute(link) || (lexical !== root && !lexical.startsWith(`${root}${path.sep}`))) throw new Error(`Symlink escapes frozen input: ${relative}`); } if (target && target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`Symlink escapes frozen input: ${relative}`); const size = Buffer.byteLength(link); files.push({ path: relative, size, sha256: createHash("sha256").update(`symlink:${link}`).digest("hex") }); continue; }
			if (entry.isDirectory()) { if (entry.name === ".git" || (entry.name === "node_modules" && !options.includeNodeModules)) continue; await walk(absolute); continue; }
			if (!entry.isFile()) throw new Error(`Unsupported file type in frozen input: ${relative}`);
			const info = await stat(absolute); files.push({ path: relative, size: info.size, sha256: await sha256File(absolute) });
		}
	}
	await walk(root); const digest = createHash("sha256").update(files.map((file) => `${file.path}\0${file.size}\0${file.sha256}`).join("\n")).digest("hex"); return { files, digest };
}

export async function safeCopyDirectory(source: string, destination: string, options: { allowDanglingInternalSymlinks?: boolean } = {}): Promise<void> {
	const sourceReal = await realpath(source); if (!(await stat(sourceReal)).isDirectory()) throw new Error(`Not a directory: ${source}`);
	await rm(destination, { recursive: true, force: true }); await mkdir(destination, { recursive: true });
	async function walk(from: string, to: string): Promise<void> {
		for (const entry of await readdir(from, { withFileTypes: true })) {
			const src = path.join(from, entry.name); const dest = path.join(to, entry.name); const info = await lstat(src);
			if (info.isSymbolicLink()) { const link = await readlink(src); let target: string; try { target = await realpath(src); } catch { target = path.resolve(path.dirname(src), link); if (!options.allowDanglingInternalSymlinks || path.isAbsolute(link) || (target !== sourceReal && !target.startsWith(`${sourceReal}${path.sep}`))) throw new Error(`Symlink escapes frozen input: ${path.relative(sourceReal, src)}`); } if (target !== sourceReal && !target.startsWith(`${sourceReal}${path.sep}`)) throw new Error(`Symlink escapes frozen input: ${path.relative(sourceReal, src)}`); const copiedTarget = path.join(destination, path.relative(sourceReal, target)); await symlink(path.relative(path.dirname(dest), copiedTarget), dest); }
			else if (info.isDirectory()) { if (entry.name === ".git" || entry.name === "node_modules") continue; await mkdir(dest, { recursive: true }); await walk(src, dest); }
			else if (info.isFile()) await cp(src, dest, { preserveTimestamps: true });
			else throw new Error(`Unsupported file type: ${src}`);
		}
	}
	await walk(sourceReal, destination);
}

export async function archiveDirectory(source: string, artifact: string): Promise<void> {
	await mkdir(path.dirname(artifact), { recursive: true }); const result = await runCommand("tar", ["-czf", artifact, "-C", source, "."], { timeout: 10 * 60_000 }); if (result.code !== 0) throw new Error(`tar failed: ${result.stderr}`);
}
export async function extractArchive(artifact: string, destination: string): Promise<void> {
	await rm(destination, { recursive: true, force: true }); await mkdir(destination, { recursive: true }); const result = await runCommand("tar", ["-xzf", artifact, "-C", destination], { timeout: 10 * 60_000 }); if (result.code !== 0) throw new Error(`tar extraction failed: ${result.stderr}`);
}

async function localRepository(repository: string, relativeTo: string): Promise<string | undefined> {
	const candidate = path.resolve(relativeTo, repository); try { const s = await stat(candidate); return s.isDirectory() ? candidate : undefined; } catch { return undefined; }
}
export async function checkoutGitTree(repository: string, ref: string, subpath: string | undefined, destination: string, relativeTo: string, options: { allowDanglingInternalSymlinks?: boolean } = {}): Promise<{ commit: string }> {
	const temp = await mkdtemp(path.join(os.tmpdir(), "skill-eval-git-"));
	try {
		const local = await localRepository(repository, relativeTo); const repo = local ?? path.join(temp, "repo");
		if (!local) { const clone = await runCommand("git", ["clone", "--quiet", "--no-checkout", "--filter=blob:none", repository, repo], { timeout: 15 * 60_000 }); if (clone.code !== 0) throw new Error(`git clone failed: ${clone.stderr}`); }
		const resolved = await runCommand("git", ["-C", repo, "rev-parse", `${ref}^{commit}`], { timeout: 60_000 }); if (resolved.code !== 0) throw new Error(`Cannot resolve immutable Git ref ${ref}: ${resolved.stderr}`); const commit = resolved.stdout.trim();
		const checkout = path.join(temp, "checkout"), tarFile = path.join(temp, "tree.tar"); await mkdir(checkout); const archiveArgs = ["-C", repo, "archive", "--format=tar", "-o", tarFile, commit]; if (subpath && subpath !== ".") archiveArgs.push(subpath);
		const archive = await runCommand("git", archiveArgs, { timeout: 5 * 60_000 }); if (archive.code !== 0) throw new Error(`git archive failed: ${archive.stderr}`); const untar = await runCommand("tar", ["-xf", tarFile, "-C", checkout], { timeout: 5 * 60_000 }); if (untar.code !== 0) throw new Error(`git archive extraction failed: ${untar.stderr}`);
		const tree = subpath && subpath !== "." ? path.join(checkout, subpath) : checkout; await safeCopyDirectory(tree, destination, options); return { commit };
	} finally { await rm(temp, { recursive: true, force: true }); }
}

export async function freezeLocalInput(source: string, artifactsDir: string, name: string, options: { allowDanglingInternalSymlinks?: boolean } = {}): Promise<FrozenInput> {
	const temp = await mkdtemp(path.join(os.tmpdir(), "skill-eval-freeze-"));
	try {
		const copy = path.join(temp, "tree"); await safeCopyDirectory(source, copy, options); const manifest = await manifestDirectory(copy, options); const artifact = path.join(artifactsDir, `${name}-${manifest.digest.slice(0, 12)}.tgz`); await archiveDirectory(copy, artifact);
		let git: FrozenInput["git"];
		try { const headResult = await runCommand("git", ["-C", source, "rev-parse", "HEAD"], { timeout: 10_000 }); const statusResult = await runCommand("git", ["-C", source, "status", "--porcelain"], { timeout: 10_000 }); git = headResult.code === 0 && statusResult.code === 0 ? { head: headResult.stdout.trim() || undefined, dirty: Boolean(statusResult.stdout.trim()) } : undefined; } catch { git = undefined; }
		return { source: path.basename(source), artifact, digest: manifest.digest, files: manifest.files, git };
	} finally { await rm(temp, { recursive: true, force: true }); }
}

export async function freezeGitInput(repository: string, ref: string, subpath: string | undefined, artifactsDir: string, name: string, relativeTo: string, options: { allowDanglingInternalSymlinks?: boolean } = {}): Promise<FrozenInput> {
	const temp = await mkdtemp(path.join(os.tmpdir(), "skill-eval-freeze-git-"));
	try { const tree = path.join(temp, "tree"); const { commit } = await checkoutGitTree(repository, ref, subpath, tree, relativeTo, options); const manifest = await manifestDirectory(tree, options); const artifact = path.join(artifactsDir, `${name}-${manifest.digest.slice(0, 12)}.tgz`); await archiveDirectory(tree, artifact); return { source: `${repository}@${commit}${subpath ? `:${subpath}` : ""}`, artifact, digest: manifest.digest, files: manifest.files, git: { head: commit, dirty: false } }; } finally { await rm(temp, { recursive: true, force: true }); }
}

export async function hashText(text: string): Promise<string> { return createHash("sha256").update(text).digest("hex"); }
export async function copyFileOrLink(source: string, destination: string): Promise<void> { await mkdir(path.dirname(destination), { recursive: true }); await cp(source, destination); }
export async function relativeSymlink(target: string, link: string): Promise<void> { await mkdir(path.dirname(link), { recursive: true }); await symlink(path.relative(path.dirname(link), target), link); }
