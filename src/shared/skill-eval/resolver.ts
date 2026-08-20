import { createHash, randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Arm, Comparison, ResolvedBlock, ResolvedCell, ResolvedPlan, ResolvedScenario, Suite } from "./domain.ts";
import { RUNNER_VERSION, relativeArtifact, targetKey, ValidationError } from "./domain.ts";
import { archiveDirectory, extractArchive, freezeGitInput, freezeLocalInput, manifestDirectory, runCommand } from "./filesystem.ts";
import { loadComparison } from "./planning.ts";
import { ensureStorage, runDirectory, runPaths, storageRoot } from "./storage.ts";
import { redactText } from "./security.ts";

function seededNumber(seed: string, value: string): number { return Number.parseInt(createHash("sha256").update(`${seed}:${value}`).digest("hex").slice(0, 12), 16); }
function shuffled<T>(values: T[], seed: string, label: (value: T) => string): T[] { return [...values].sort((a, b) => seededNumber(seed, label(a)) - seededNumber(seed, label(b))); }
function safeId(value: string): string { return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "eval"; }
export function createRunId(name: string): string { const date = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); return `${date}-${safeId(name)}-${randomUUID().slice(0, 8)}`; }

async function validateModels(planTargets: Array<{ harness: string; model: string; thinking: string }>): Promise<void> {
	const result = await runCommand("pi", ["--list-models"], { timeout: 30_000 }); if (result.code !== 0) throw new ValidationError([`Cannot inspect Pi models: ${result.stderr}`]);
	const models = new Map<string, boolean>();
	for (const line of result.stdout.split("\n").slice(1)) { const columns = line.trim().split(/\s+/); if (columns.length >= 6) models.set(`${columns[0]}/${columns[1]}`, columns[4] === "yes"); }
	const issues: string[] = [];
	for (const target of planTargets) { if (target.harness !== "pi") { issues.push(`Harness ${target.harness} is unavailable in milestone 1`); continue; } if (!target.model.includes("/")) { issues.push(`Pi target model must be exact provider/model: ${target.model}`); continue; } const thinking = models.get(target.model); if (thinking === undefined) issues.push(`Pi model is unavailable: ${target.model}`); else if (target.thinking !== "off" && !thinking) issues.push(`Pi model does not support thinking: ${target.model}`); }
	if (issues.length) throw new ValidationError(issues);
}

async function freezeFixtureRaw(suite: Suite, scenario: Suite["scenarios"][number], artifacts: string): Promise<{ artifact: string }> {
	const name = `fixture-${safeId(scenario.id)}-raw`, options = { allowDanglingInternalSymlinks: true }, fixture = scenario.fixture;
	if (fixture.type === "local") {
		const source = path.resolve(path.dirname(suite.file), fixture.path!); const frozen = await freezeLocalInput(source, artifacts, name, options); return { artifact: frozen.artifact };
	}
	const frozen = await freezeGitInput(fixture.repository!, fixture.ref!, undefined, artifacts, name, path.dirname(suite.file), options); return { artifact: frozen.artifact };
}

async function commandExists(command: string): Promise<boolean> { return (await runCommand("sh", ["-lc", `command -v ${command}`], { timeout: 5_000 })).code === 0; }
async function rejectUnsupportedFixture(workspace: string): Promise<void> {
	const { readdir } = await import("node:fs/promises"); async function walk(directory: string): Promise<void> { for (const entry of await readdir(directory, { withFileTypes: true })) { if (entry.name === ".git" || entry.name === "node_modules") continue; const file = path.join(directory, entry.name); if (entry.isDirectory()) await walk(file); else if (entry.isFile() && (await stat(file)).size < 1024 && (await readFile(file, "utf8").catch(() => "")).startsWith("version https://git-lfs.github.com/spec/v1")) throw new Error(`Git LFS pointer is unsupported: ${path.relative(workspace, file)}`); } } await walk(workspace); const indexed = await runCommand("git", ["ls-files", "--stage"], { cwd: workspace, timeout: 60_000 }); if (indexed.code !== 0) throw new Error(`Cannot inspect fixture Git index: ${indexed.stderr}`); const submodule = indexed.stdout.split("\n").find((line) => line.startsWith("160000 ")); if (submodule) throw new Error(`Git submodules are unsupported in milestone 1 fixtures: ${submodule.split("\t")[1] ?? "unknown"}`);
}
async function checkpoint(workspace: string): Promise<void> { for (const args of [["init", "--quiet"], ["config", "user.email", "skill-eval@localhost"], ["config", "user.name", "Skill Eval"], ["add", "-A"], ["commit", "--quiet", "--allow-empty", "-m", "prepared fixture"]]) { const result = await runCommand("git", args, { cwd: workspace, timeout: 60_000 }); if (result.code !== 0) throw new Error(`Cannot create fixture grading checkpoint: ${result.stderr}`); } }
async function prepareFixture(runDir: string, suite: Suite, scenario: Suite["scenarios"][number], rawArtifact: string, artifacts: string, notify?: ResolveOptions["onFixturePreparationProgress"]): Promise<{ artifact: string; manifestArtifact: string; digest: string; fixture: typeof scenario.fixture }> {
	const fixture = { ...scenario.fixture, setup: scenario.fixture.setup ? { ...scenario.fixture.setup } : undefined };
	if (fixture.setup?.script) { const suiteRoot = path.dirname(suite.file), source = path.resolve(suiteRoot, fixture.setup.script); if (source !== suiteRoot && !source.startsWith(`${suiteRoot}${path.sep}`)) throw new ValidationError([`Setup script escapes the suite directory: ${fixture.setup.script}`]); const target = path.join(artifacts, `setup-${safeId(scenario.id)}${path.extname(source) || ".sh"}`); await copyFile(source, target); fixture.setup.script = relativeArtifact(runDir, target); }
	const workspace = await mkdtemp(path.join(os.tmpdir(), "skill-eval-prepare-")), log = path.join(artifacts, `setup-${safeId(scenario.id)}.log`);
	try {
		await preparationEvent(artifacts, { scenarioId: scenario.id, stage: "extract", status: "started", message: "Extracting raw fixture" }, notify); await extractArchive(rawArtifact, workspace); await preparationEvent(artifacts, { scenarioId: scenario.id, stage: "extract", status: "completed", message: "Raw fixture extracted" }, notify);
		if (fixture.setup) { const started = Date.now(); await preparationEvent(artifacts, { scenarioId: scenario.id, stage: "setup", status: "started", message: "Running fixture setup" }, notify); let command = "sh", args = fixture.setup.script ? [path.resolve(runDir, fixture.setup.script)] : ["-lc", fixture.setup.command!]; if (!fixture.setup.network && process.platform === "darwin" && await commandExists("sandbox-exec")) { args = ["-p", "(version 1) (allow default) (deny network*)", command, ...args]; command = "sandbox-exec"; } const env: NodeJS.ProcessEnv = { ...process.env, PI_OFFLINE: fixture.setup.network ? "0" : "1", npm_config_offline: fixture.setup.network ? "false" : "true", PIP_NO_INDEX: fixture.setup.network ? "0" : "1", HOMEBREW_NO_AUTO_UPDATE: "1" }; let result; try { result = await runCommand(command, args, { cwd: workspace, env, timeout: scenario.limits.setupTimeout, maxOutput: 4 * 1024 * 1024 }); } catch (error) { await writeFile(log, redactText(`Setup could not start: ${error instanceof Error ? error.message : String(error)}`, [workspace, runDir, process.env.HOME ?? ""]), { mode: 0o600 }); await preparationEvent(artifacts, { scenarioId: scenario.id, stage: "setup", status: "failed", message: "Fixture setup could not start", durationMs: Date.now() - started }, notify); throw error; } await writeFile(log, redactText(`exit=${result.code}\n\nstdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`, [workspace, runDir, process.env.HOME ?? ""]), { mode: 0o600 }); if (result.code !== 0) { await preparationEvent(artifacts, { scenarioId: scenario.id, stage: "setup", status: "failed", message: `Fixture setup exited ${result.code}`, durationMs: result.durationMs }, notify); throw new Error(`Setup failed for ${scenario.id} (exit ${result.code}); see ${path.basename(log)}`); } await preparationEvent(artifacts, { scenarioId: scenario.id, stage: "setup", status: "completed", message: "Fixture setup completed", durationMs: result.durationMs }, notify); }
		await preparationEvent(artifacts, { scenarioId: scenario.id, stage: "final_validation", status: "started", message: "Validating prepared fixture" }, notify); const manifest = await manifestDirectory(workspace, { includeNodeModules: true }); await preparationEvent(artifacts, { scenarioId: scenario.id, stage: "final_validation", status: "completed", message: "Prepared fixture validated" }, notify); await preparationEvent(artifacts, { scenarioId: scenario.id, stage: "checkpoint", status: "started", message: "Creating fixture checkpoint" }, notify); await checkpoint(workspace); await rejectUnsupportedFixture(workspace); await preparationEvent(artifacts, { scenarioId: scenario.id, stage: "checkpoint", status: "completed", message: "Fixture checkpoint created" }, notify); const artifact = path.join(artifacts, `prepared-${safeId(scenario.id)}-${manifest.digest.slice(0, 12)}.tgz`), manifestArtifact = path.join(artifacts, `prepared-${safeId(scenario.id)}.manifest.json`); await preparationEvent(artifacts, { scenarioId: scenario.id, stage: "archive", status: "started", message: "Archiving prepared fixture" }, notify); await archiveDirectory(workspace, artifact); await writeFile(manifestArtifact, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 }); await preparationEvent(artifacts, { scenarioId: scenario.id, stage: "archive", status: "completed", message: "Prepared fixture archived" }, notify); return { artifact, manifestArtifact, digest: manifest.digest, fixture };
	} finally { await rm(workspace, { recursive: true, force: true }); }
}

async function skillDiff(baselineArtifact: string, candidateArtifact: string, artifact: string): Promise<void> {
	const temp = await mkdtemp(path.join(os.tmpdir(), "skill-eval-diff-"));
	try { const baseline = path.join(temp, "baseline"), candidate = path.join(temp, "candidate"); await extractArchive(baselineArtifact, baseline); await extractArchive(candidateArtifact, candidate); const result = await runCommand("git", ["diff", "--no-index", "--", baseline, candidate], { timeout: 60_000, maxOutput: 16 * 1024 * 1024 }); if (result.code !== 0 && result.code !== 1) throw new Error(`Cannot compute skill diff: ${result.stderr}`); const normalized = result.stdout.replaceAll(baseline, "baseline").replaceAll(candidate, "candidate"); await writeFile(artifact, normalized, { mode: 0o600 }); } finally { await rm(temp, { recursive: true, force: true }); }
}

function buildBlocks(runId: string, scenarios: ResolvedScenario[], profile: ResolvedPlan["profile"], seed: string): ResolvedBlock[] {
	const descriptors: Array<{ scenario: ResolvedScenario; target: ResolvedPlan["profile"]["targets"][number]; repetition: number }> = [];
	for (const scenario of scenarios) for (const target of profile.targets) for (let repetition = 1; repetition <= profile.repetitions; repetition++) descriptors.push({ scenario, target, repetition });
	return shuffled(descriptors, seed, (d) => `${d.scenario.id}:${targetKey(d.target)}:${d.repetition}`).map((descriptor, order) => {
		const id = `b${String(order + 1).padStart(4, "0")}-${safeId(descriptor.scenario.id)}`; const arms = shuffled(descriptor.scenario.runOn, seed, (arm) => `${id}:${arm}`);
		const cells: ResolvedCell[] = arms.map((arm, cellOrder) => ({ id: `${id}-${arm}`, blockId: id, scenarioId: descriptor.scenario.id, arm, target: descriptor.target, repetition: descriptor.repetition, order: cellOrder, workspace: `workspaces/${id}-${arm}`, skillArtifact: arm === "control" ? undefined : `artifacts/skill-${arm}.tgz` }));
		return { id, scenarioId: descriptor.scenario.id, target: descriptor.target, repetition: descriptor.repetition, order, cells };
	});
}

export interface FixturePreparationProgress { scenarioId: string; stage: "raw_freeze" | "extract" | "setup" | "final_validation" | "checkpoint" | "archive"; status: "started" | "completed" | "failed"; message: string; durationMs?: number }
export interface ResolveOptions { profile?: string; runId?: string; skipModelValidation?: boolean; onFixturePreparationProgress?: (progress: FixturePreparationProgress) => Promise<void> | void }
async function preparationEvent(artifacts: string, progress: FixturePreparationProgress, notify?: ResolveOptions["onFixturePreparationProgress"]): Promise<void> { const event = { timestamp: new Date().toISOString(), ...progress }; await appendFile(path.join(artifacts, `preparation-${safeId(progress.scenarioId)}.jsonl`), `${JSON.stringify(event)}\n`, { mode: 0o600 }); await notify?.(progress); }
async function retainValidationDiagnostics(runDir: string, runId: string, error: unknown): Promise<string | undefined> { const artifacts = runPaths(runDir).artifacts, files = await readdir(artifacts).catch(() => []); if (!files.some((file) => file.startsWith("preparation-") || file.startsWith("setup-"))) return undefined; const destination = path.join(storageRoot(), "diagnostics", runId); await mkdir(destination, { recursive: true, mode: 0o700 }); for (const file of files.filter((file) => file.startsWith("preparation-") || file.startsWith("setup-"))) await copyFile(path.join(artifacts, file), path.join(destination, file)); await writeFile(path.join(destination, "failure.json"), `${JSON.stringify({ runId, failedAt: new Date().toISOString(), error: redactText(error instanceof Error ? error.stack ?? error.message : String(error), [runDir, process.env.HOME ?? ""]) }, null, 2)}\n`, { mode: 0o600 }); return destination; }
export async function resolveComparison(file: string, options: ResolveOptions = {}): Promise<ResolvedPlan> {
	const { comparison, suite, warnings } = await loadComparison(file); const profileName = options.profile ?? comparison.execution.profile; const profile = suite.profiles[profileName]; if (!profile) throw new ValidationError([`Unknown profile override: ${profileName}`]);
	if (!options.skipModelValidation) await validateModels(profile.targets); const piVersion = options.skipModelValidation ? "capability-validation-skipped" : (await runCommand("pi", ["--version"], { timeout: 10_000 })).stdout.trim();
	const runId = options.runId ?? createRunId(comparison.name); await ensureStorage(); const runDir = runDirectory(runId); const artifacts = runPaths(runDir).artifacts; await mkdir(artifacts, { recursive: true, mode: 0o700 });
	try {
		const baseline = await freezeGitInput(suite.skill.source.repository, comparison.arms.baseline.ref, suite.skill.path, artifacts, "skill-baseline", path.dirname(suite.file));
		const candidate = comparison.arms.candidate.ref
			? await freezeGitInput(suite.skill.source.repository, comparison.arms.candidate.ref, suite.skill.path, artifacts, "skill-candidate", path.dirname(suite.file))
			: await freezeLocalInput(path.resolve(path.dirname(comparison.file), comparison.arms.candidate.snapshot!.path), artifacts, "skill-candidate");
		const baselineStable = path.join(artifacts, "skill-baseline.tgz"), candidateStable = path.join(artifacts, "skill-candidate.tgz"); await (await import("node:fs/promises")).copyFile(baseline.artifact, baselineStable); await (await import("node:fs/promises")).copyFile(candidate.artifact, candidateStable); await rm(baseline.artifact, { force: true }); await rm(candidate.artifact, { force: true }); baseline.artifact = baselineStable; candidate.artifact = candidateStable;
		const diffArtifact = path.join(artifacts, "skill-diff.patch"); await skillDiff(baselineStable, candidateStable, diffArtifact);
		const selectedIds = comparison.execution.scenarios.include ?? suite.scenarios.map((s) => s.id); const scenarios: ResolvedScenario[] = [];
		for (const scenario of suite.scenarios.filter((s) => selectedIds.includes(s.id))) {
			const freezeStarted = Date.now(); await preparationEvent(artifacts, { scenarioId: scenario.id, stage: "raw_freeze", status: "started", message: "Freezing raw fixture" }, options.onFixturePreparationProgress); let raw; try { raw = await freezeFixtureRaw(suite, scenario, artifacts); } catch (error) { await preparationEvent(artifacts, { scenarioId: scenario.id, stage: "raw_freeze", status: "failed", message: "Raw fixture freeze failed", durationMs: Date.now() - freezeStarted }, options.onFixturePreparationProgress); throw error; } await preparationEvent(artifacts, { scenarioId: scenario.id, stage: "raw_freeze", status: "completed", message: "Raw fixture frozen", durationMs: Date.now() - freezeStarted }, options.onFixturePreparationProgress); const prepared = await prepareFixture(runDir, suite, scenario, raw.artifact, artifacts, options.onFixturePreparationProgress); await rm(raw.artifact, { force: true }); const promptFile = path.join(artifacts, `prompt-${safeId(scenario.id)}.txt`); await writeFile(promptFile, scenario.prompt, { mode: 0o600 });
			const { prompt: _prompt, ...resolvedScenario } = scenario; scenarios.push({ ...resolvedScenario, fixture: prepared.fixture, promptArtifact: relativeArtifact(runDir, promptFile), fixtureArtifact: relativeArtifact(runDir, prepared.artifact), fixtureManifestArtifact: relativeArtifact(runDir, prepared.manifestArtifact), fixtureDigest: prepared.digest });
		}
		const seed = createHash("sha256").update(`${runId}:${comparison.name}:${baseline.digest}:${candidate.digest}`).digest("hex").slice(0, 16);
		const plan: ResolvedPlan = { schemaVersion: 1, runnerVersion: RUNNER_VERSION, harnessVersions: { pi: piVersion }, runId, createdAt: new Date().toISOString(), comparisonName: comparison.name, comparisonFile: path.basename(comparison.file), suiteFile: path.basename(suite.file), profileName, profileOverridden: Boolean(options.profile && options.profile !== comparison.execution.profile), seed, isolationLevel: "best-effort", warnings: [...warnings, "Strong OS sandboxing is not implemented in milestone 1 on this host; evaluated cells use best-effort process, path, tool, and environment guards."], skill: { name: suite.skill.name, control: { disabled: true }, baseline: { ...baseline, artifact: relativeArtifact(runDir, baselineStable), source: `<skill-source>@${baseline.git?.head ?? comparison.arms.baseline.ref}:${suite.skill.path}` }, candidate: { ...candidate, artifact: relativeArtifact(runDir, candidateStable), source: comparison.arms.candidate.ref ? `<skill-source>@${candidate.git?.head ?? comparison.arms.candidate.ref}:${suite.skill.path}` : "<local-candidate-snapshot>" }, diffArtifact: relativeArtifact(runDir, diffArtifact) }, scenarios, profile, acceptance: comparison.acceptance, hypotheses: comparison.hypotheses, blocks: [] };
		plan.blocks = buildBlocks(runId, scenarios, profile, seed); return plan;
	} catch (error) { const diagnostic = await retainValidationDiagnostics(runDir, runId, error).catch(() => undefined); await rm(runDir, { recursive: true, force: true }); if (!diagnostic) throw error; const message = `${error instanceof Error ? error.message : String(error)}\nFixture preparation diagnostics: ${diagnostic}`; if (error instanceof ValidationError) throw new ValidationError([...error.issues, `Fixture preparation diagnostics: ${diagnostic}`]); throw new Error(message); }
}

export function formatPlanPreview(plan: ResolvedPlan): string {
	const arms = new Set(plan.blocks.flatMap((block) => block.cells.map((cell) => cell.arm))); const maxCost = plan.profile.limits?.maxCost;
	return [
		`Skill evaluation: ${plan.comparisonName}`,
		`Run: ${plan.runId}`,
		`Profile: ${plan.profileName}${plan.profileOverridden ? " (explicit override)" : ""}`,
		`Scenarios: ${plan.scenarios.length}`,
		`Targets: ${plan.profile.targets.map(targetKey).join(", ")}`,
		`Pi version: ${plan.harnessVersions.pi}`,
		`Arms: ${[...arms].join(", ")}`,
		`Repetitions: ${plan.profile.repetitions}`,
		`Blocks / cells: ${plan.blocks.length} / ${plan.blocks.reduce((sum, block) => sum + block.cells.length, 0)}`,
		`Maximum concurrency within a paired block: ${plan.profile.maxConcurrency}`,
		`Evaluation budget: ${maxCost === undefined ? "uncapped" : `$${maxCost.toFixed(2)} observed spend`}`,
		`Agent network: ${plan.scenarios.some((s) => s.permissions.network) ? "enabled in at least one scenario" : "disabled"}`,
		`Setup network: ${plan.scenarios.some((s) => s.fixture.setup?.network) ? "enabled in at least one scenario (trusted validation host code)" : "disabled"}`,
		`Isolation: ${plan.isolationLevel.toUpperCase()} — review warning below`,
		`Baseline: ${plan.skill.baseline.source} · ${plan.skill.baseline.digest.slice(0, 12)}`,
		`Candidate: ${plan.skill.candidate.source} · ${plan.skill.candidate.digest.slice(0, 12)}`,
		"Scenario permissions and trusted fixture setup (run during validation):",
		...plan.scenarios.map((scenario) => `  - ${scenario.id}: ${scenario.permissions.mode}; tools=${scenario.tools.join(",")}; agent-network=${scenario.permissions.network}; setup=${scenario.fixture.setup?.command ?? scenario.fixture.setup?.script ?? "none"}; setup-network=${scenario.fixture.setup?.network ?? false}`),
		...plan.warnings.map((warning) => `Warning: ${warning}`),
	].join("\n");
}
