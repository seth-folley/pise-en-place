import { parse } from "yaml";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { AcceptanceRule, Arm, CheckSpec, Comparison, Fixture, Limits, Permissions, Profile, RUNNER_TIMEOUTS, SUPPORTED_TOOLS, Scenario, Suite, THINKING_LEVELS, ValidationError } from "./domain.ts";

type Obj = Record<string, unknown>;
const own = (o: Obj, key: string) => Object.prototype.hasOwnProperty.call(o, key);

function object(value: unknown, at: string, issues: string[]): Obj {
	if (!value || typeof value !== "object" || Array.isArray(value)) { issues.push(`${at} must be an object`); return {}; }
	return value as Obj;
}
function strict(o: Obj, allowed: string[], at: string, issues: string[]): void {
	for (const key of Object.keys(o)) if (!allowed.includes(key) && key !== "metadata") issues.push(`${at}.${key} is unknown`);
	if (o.metadata !== undefined && (!o.metadata || typeof o.metadata !== "object" || Array.isArray(o.metadata))) issues.push(`${at}.metadata must be an object`);
}
function text(o: Obj, key: string, at: string, issues: string[], optional = false): string | undefined {
	const value = o[key];
	if (value === undefined && optional) return undefined;
	if (typeof value !== "string" || !value.trim()) { issues.push(`${at}.${key} must be a non-empty string`); return undefined; }
	return value.trim();
}
function identifier(o: Obj, key: string, at: string, issues: string[]): string {
	const value = text(o, key, at, issues) ?? ""; if (value && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) issues.push(`${at}.${key} must use 1–80 letters, numbers, dots, underscores, or hyphens`); return value;
}
function num(o: Obj, key: string, at: string, issues: string[], fallback?: number): number {
	const value = o[key];
	if (value === undefined && fallback !== undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value)) { issues.push(`${at}.${key} must be a finite number`); return fallback ?? 0; }
	return value;
}
function bool(o: Obj, key: string, at: string, issues: string[], fallback?: boolean): boolean {
	const value = o[key];
	if (value === undefined && fallback !== undefined) return fallback;
	if (typeof value !== "boolean") { issues.push(`${at}.${key} must be boolean`); return fallback ?? false; }
	return value;
}
function list(value: unknown, at: string, issues: string[]): unknown[] {
	if (!Array.isArray(value)) { issues.push(`${at} must be an array`); return []; }
	return value;
}
function strings(value: unknown, at: string, issues: string[], allowEmpty = false): string[] {
	const values = list(value, at, issues);
	const result: string[] = [];
	values.forEach((item, index) => typeof item === "string" && item.trim() ? result.push(item.trim()) : issues.push(`${at}[${index}] must be a non-empty string`));
	if (!allowEmpty && result.length === 0) issues.push(`${at} must not be empty`);
	return result;
}
function unique(values: string[], at: string, issues: string[]): void {
	const seen = new Set<string>();
	for (const value of values) { if (seen.has(value)) issues.push(`${at} contains duplicate ${value}`); seen.add(value); }
}
function duration(value: unknown, at: string, issues: string[], fallback: number): number {
	if (value === undefined) return fallback;
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	if (typeof value === "string") {
		const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value.trim());
		if (match) return Number(match[1]) * ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2]!]!);
	}
	issues.push(`${at} must be a positive duration such as 10m`); return fallback;
}
function permissions(value: unknown, at: string, issues: string[], base: Permissions = { mode: "workspace-write", network: false }): Permissions {
	if (value === undefined) return { ...base };
	const o = object(value, at, issues); strict(o, ["mode", "network"], at, issues);
	const mode = o.mode === undefined ? base.mode : o.mode;
	if (mode !== "read-only" && mode !== "workspace-write") issues.push(`${at}.mode must be read-only or workspace-write`);
	return { mode: mode === "read-only" ? "read-only" : "workspace-write", network: bool(o, "network", at, issues, base.network) };
}
function limits(value: unknown, at: string, issues: string[], base: Limits = { setupTimeout: RUNNER_TIMEOUTS.setup, scenarioTimeout: RUNNER_TIMEOUTS.scenario, checkTimeout: RUNNER_TIMEOUTS.check }): Limits {
	if (value === undefined) return { ...base };
	const o = object(value, at, issues); strict(o, ["setupTimeout", "scenarioTimeout", "checkTimeout"], at, issues);
	return { setupTimeout: duration(o.setupTimeout, `${at}.setupTimeout`, issues, base.setupTimeout), scenarioTimeout: duration(o.scenarioTimeout, `${at}.scenarioTimeout`, issues, base.scenarioTimeout), checkTimeout: duration(o.checkTimeout, `${at}.checkTimeout`, issues, base.checkTimeout) };
}
function setup(value: unknown, at: string, issues: string[]): Fixture["setup"] {
	if (value === undefined) return undefined;
	const o = object(value, at, issues); strict(o, ["command", "script", "network"], at, issues);
	const command = text(o, "command", at, issues, true); const script = text(o, "script", at, issues, true);
	if (Boolean(command) === Boolean(script)) issues.push(`${at} requires exactly one of command or script`);
	return { command, script, network: bool(o, "network", at, issues, false) };
}
function fixture(value: unknown, at: string, issues: string[]): Fixture {
	const o = object(value, at, issues); strict(o, ["type", "path", "repository", "ref", "setup"], at, issues);
	if (o.type === "local") {
		const p = text(o, "path", at, issues);
		if (own(o, "repository") || own(o, "ref")) issues.push(`${at} local fixture rejects repository/ref`);
		return { type: "local", path: p, setup: setup(o.setup, `${at}.setup`, issues) };
	}
	if (o.type === "git") {
		const repository = text(o, "repository", at, issues); const ref = text(o, "ref", at, issues);
		if (own(o, "path")) issues.push(`${at} git fixture rejects path`);
		return { type: "git", repository, ref, setup: setup(o.setup, `${at}.setup`, issues) };
	}
	issues.push(`${at}.type must be local or git`); return { type: "local", path: "" };
}
function expectation(type: CheckSpec["type"], value: unknown, at: string, issues: string[]): Obj {
	const o = object(value, at, issues);
	const allowed: Record<CheckSpec["type"], string[]> = {
		command: ["exitCode", "stdoutContains", "stderrContains"],
		"file-exists": ["exists"],
		"file-contains": ["contains", "notContains"],
		"git-diff": ["allowedPaths", "requiredPaths", "forbiddenPatterns", "maxFiles"],
		"trace-command": ["called", "minCount", "maxCount"],
	};
	strict(o, allowed[type], at, issues);
	if (type === "command" && o.exitCode === undefined) issues.push(`${at}.exitCode is required`);
	if (type === "file-contains" && o.contains === undefined && o.notContains === undefined) issues.push(`${at} needs contains or notContains`);
	for (const key of ["stdoutContains", "stderrContains", "contains", "notContains", "allowedPaths", "requiredPaths", "forbiddenPatterns"]) if (o[key] !== undefined) strings(o[key], `${at}.${key}`, issues);
	for (const key of ["exitCode", "maxFiles", "minCount", "maxCount"]) if (o[key] !== undefined && (typeof o[key] !== "number" || !Number.isFinite(o[key]))) issues.push(`${at}.${key} must be a number`);
	if (o.exists !== undefined && typeof o.exists !== "boolean") issues.push(`${at}.exists must be boolean`);
	if (o.called !== undefined && o.called !== "at-least-once" && o.called !== "never") issues.push(`${at}.called must be at-least-once or never`);
	if (type === "trace-command" && o.called === undefined && o.minCount === undefined) issues.push(`${at} requires called or minCount`);
	return o;
}
function checks(value: unknown, at: string, issues: string[]): CheckSpec[] {
	const result: CheckSpec[] = [];
	for (const [index, item] of list(value, at, issues).entries()) {
		const p = `${at}[${index}]`; const o = object(item, p, issues); strict(o, ["id", "type", "severity", "command", "path", "expect"], p, issues);
		const id = identifier(o, "id", p, issues) || `invalid-${index}`;
		const types = ["command", "file-exists", "file-contains", "git-diff", "trace-command"] as const;
		const type = types.includes(o.type as never) ? o.type as CheckSpec["type"] : (issues.push(`${p}.type is unsupported`), "command");
		const severity = o.severity === "critical" || o.severity === "advisory" ? o.severity : (issues.push(`${p}.severity must be critical or advisory`), "critical");
		const command = text(o, "command", p, issues, type !== "command");
		const filePath = text(o, "path", p, issues, type !== "file-exists" && type !== "file-contains");
		if (type === "trace-command" && !own(o, "command")) issues.push(`${p}.command is required for trace-command`);
		result.push({ id, type, severity, command, path: filePath, expect: expectation(type, o.expect, `${p}.expect`, issues) });
	}
	unique(result.map((c) => c.id), at, issues); return result;
}
async function prompt(o: Obj, at: string, suiteFile: string, issues: string[]): Promise<string> {
	strict(o, ["id", "title", "covers", "purpose", "prompt", "promptFile", "fixture", "invocation", "runOn", "tools", "permissions", "limits", "checks", "rubric"], at, issues);
	const inline = text(o, "prompt", at, issues, true); const file = text(o, "promptFile", at, issues, true);
	if (Boolean(inline) === Boolean(file)) { issues.push(`${at} requires exactly one of prompt or promptFile`); return inline ?? ""; }
	if (!file) return inline!;
	const absolute = path.resolve(path.dirname(suiteFile), file);
	try { return await readFile(absolute, "utf8"); } catch (error) { issues.push(`${at}.promptFile cannot be read: ${error instanceof Error ? error.message : String(error)}`); return ""; }
}

export async function loadSuite(file: string): Promise<Suite> {
	const absolute = path.resolve(file); const issues: string[] = [];
	let root: Obj;
	try { root = object(parse(await readFile(absolute, "utf8")), "suite", issues); } catch (error) { throw new ValidationError([`Cannot parse suite ${absolute}: ${error instanceof Error ? error.message : String(error)}`]); }
	strict(root, ["schemaVersion", "kind", "name", "skill", "defaults", "profiles", "scenarios"], "suite", issues);
	if (root.schemaVersion !== 1) issues.push("suite.schemaVersion must be 1"); if (root.kind !== "skill-eval-suite") issues.push("suite.kind must be skill-eval-suite"); const suiteName = text(root, "name", "suite", issues) ?? "";
	const skillO = object(root.skill, "suite.skill", issues); strict(skillO, ["name", "source", "path"], "suite.skill", issues); const skillName = text(skillO, "name", "suite.skill", issues) ?? ""; const skillPath = text(skillO, "path", "suite.skill", issues) ?? "";
	const sourceO = object(skillO.source, "suite.skill.source", issues); strict(sourceO, ["type", "repository"], "suite.skill.source", issues); if (sourceO.type !== "git") issues.push("suite.skill.source.type must be git"); const repository = text(sourceO, "repository", "suite.skill.source", issues) ?? "";
	const defaultsO = object(root.defaults, "suite.defaults", issues); strict(defaultsO, ["tools", "permissions", "limits"], "suite.defaults", issues);
	const defaultTools = strings(defaultsO.tools, "suite.defaults.tools", issues); defaultTools.forEach((tool) => { if (!SUPPORTED_TOOLS.has(tool)) issues.push(`Unsupported tool: ${tool}`); });
	const defaultPermissions = permissions(defaultsO.permissions, "suite.defaults.permissions", issues); const defaultLimits = limits(defaultsO.limits, "suite.defaults.limits", issues);
	const profilesO = object(root.profiles, "suite.profiles", issues); if (Object.keys(profilesO).length === 0) issues.push("suite.profiles must not be empty"); const profiles: Record<string, Profile> = {};
	for (const [name, value] of Object.entries(profilesO)) {
		const at = `suite.profiles.${name}`; const o = object(value, at, issues); strict(o, ["repetitions", "maxConcurrency", "targets", "limits"], at, issues);
		const repetitions = num(o, "repetitions", at, issues, 1); const maxConcurrency = num(o, "maxConcurrency", at, issues, 1);
		if (!Number.isInteger(repetitions) || repetitions < 1) issues.push(`${at}.repetitions must be a positive integer`); if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) issues.push(`${at}.maxConcurrency must be a positive integer`);
		const targetItems = list(o.targets, `${at}.targets`, issues); if (targetItems.length === 0) issues.push(`${at}.targets must not be empty`); const targets = targetItems.map((item, index) => {
			const p = `${at}.targets[${index}]`; const t = object(item, p, issues); strict(t, ["harness", "model", "thinking"], p, issues);
			const harnesses = ["pi", "codex", "claude-code"] as const; if (!harnesses.includes(t.harness as never)) issues.push(`${p}.harness is unknown`); const harness = harnesses.includes(t.harness as never) ? t.harness as (typeof harnesses)[number] : "pi";
			const model = text(t, "model", p, issues) ?? ""; const thinking = text(t, "thinking", p, issues) ?? ""; if (!THINKING_LEVELS.has(thinking)) issues.push(`${p}.thinking is unsupported`);
			return { harness, model, thinking };
		});
		const profileLimits = o.limits === undefined ? undefined : (() => { const p = object(o.limits, `${at}.limits`, issues); strict(p, ["maxCost"], `${at}.limits`, issues); const maxCost = num(p, "maxCost", `${at}.limits`, issues); if (maxCost <= 0) issues.push(`${at}.limits.maxCost must be positive`); return { maxCost }; })();
		profiles[name] = { repetitions, maxConcurrency, targets, limits: profileLimits };
	}
	const scenarioList: Scenario[] = []; const scenarioItems = list(root.scenarios, "suite.scenarios", issues); if (scenarioItems.length === 0) issues.push("suite.scenarios must not be empty");
	for (const [index, item] of scenarioItems.entries()) {
		const at = `suite.scenarios[${index}]`; const o = object(item, at, issues); const resolvedPrompt = await prompt(o, at, absolute, issues);
		const invocationValues = ["explicit", "implicit", "contextual", "forbidden"] as const; const invocation = invocationValues.includes(o.invocation as never) ? o.invocation as Scenario["invocation"] : (issues.push(`${at}.invocation is invalid`), "implicit");
		const runOn = strings(o.runOn, `${at}.runOn`, issues) as Arm[]; runOn.forEach((arm) => { if (!["control", "baseline", "candidate"].includes(arm)) issues.push(`${at}.runOn has invalid arm ${arm}`); }); unique(runOn, `${at}.runOn`, issues);
		const tools = o.tools === undefined ? [...defaultTools] : strings(o.tools, `${at}.tools`, issues); tools.forEach((tool) => { if (!SUPPORTED_TOOLS.has(tool)) issues.push(`Unsupported tool: ${tool}`); });
		const rubric = o.rubric === undefined ? [] : list(o.rubric, `${at}.rubric`, issues).map((value, ri) => { const p = `${at}.rubric[${ri}]`; const r = object(value, p, issues); strict(r, ["id", "description", "weight"], p, issues); return { id: identifier(r, "id", p, issues), description: text(r, "description", p, issues) ?? "", weight: num(r, "weight", p, issues) }; });
		scenarioList.push({ id: identifier(o, "id", at, issues) || `invalid-${index}`, title: text(o, "title", at, issues) ?? "", covers: strings(o.covers, `${at}.covers`, issues), purpose: text(o, "purpose", at, issues) ?? "", prompt: resolvedPrompt, fixture: fixture(o.fixture, `${at}.fixture`, issues), invocation, runOn, tools, permissions: permissions(o.permissions, `${at}.permissions`, issues, defaultPermissions), limits: limits(o.limits, `${at}.limits`, issues, defaultLimits), checks: checks(o.checks, `${at}.checks`, issues), rubric });
	}
	unique(scenarioList.map((s) => s.id), "suite.scenarios", issues);
	if (issues.length) throw new ValidationError(issues);
	return { schemaVersion: 1, kind: "skill-eval-suite", name: suiteName, file: absolute, skill: { name: skillName, source: { type: "git", repository }, path: skillPath }, defaults: { tools: defaultTools, permissions: defaultPermissions, limits: defaultLimits }, profiles, scenarios: scenarioList };
}

function acceptance(value: unknown, issues: string[]): Comparison["acceptance"] {
	const o = object(value, "comparison.acceptance", issues); strict(o, ["mode", "rules"], "comparison.acceptance", issues);
	if (o.mode === "exploratory") { if (own(o, "rules")) issues.push("comparison.acceptance exploratory mode rejects rules"); return { mode: "exploratory", rules: [] }; }
	if (o.mode !== "gated") issues.push("comparison.acceptance.mode must be gated or exploratory");
	const rules: AcceptanceRule[] = []; const ids: string[] = [];
	for (const [index, item] of list(o.rules, "comparison.acceptance.rules", issues).entries()) {
		const at = `comparison.acceptance.rules[${index}]`; const r = object(item, at, issues); strict(r, ["id", "type", "scope", "minimum", "maximum", "compareTo"], at, issues);
		const id = identifier(r, "id", at, issues) || `invalid-${index}`; ids.push(id); const type = text(r, "type", at, issues) ?? "";
		if (["required-cell-completeness", "all-candidate-critical-checks-pass", "no-critical-regressions"].includes(type)) { if (["scope", "minimum", "maximum", "compareTo"].some((k) => own(r, k))) issues.push(`${at} non-numeric rule rejects scope/threshold fields`); rules.push({ id, type } as AcceptanceRule); continue; }
		const scope = r.scope; if (!["overall", "eachScenario", "eachTarget"].includes(scope as string)) issues.push(`${at}.scope is required and invalid`);
		if (type === "candidate-pass-rate") { rules.push({ id, type, scope: scope as never, minimum: num(r, "minimum", at, issues) }); continue; }
		if (type === "pass-rate-delta") { if (r.compareTo !== "baseline" && r.compareTo !== "control") issues.push(`${at}.compareTo must be baseline or control`); rules.push({ id, type, compareTo: r.compareTo as never, scope: scope as never, minimum: num(r, "minimum", at, issues) }); continue; }
		if (type === "median-cost-increase" || type === "median-duration-increase") { if (r.compareTo !== "baseline" && r.compareTo !== "control") issues.push(`${at}.compareTo must be baseline or control`); rules.push({ id, type, compareTo: r.compareTo as never, scope: scope as never, maximum: num(r, "maximum", at, issues) }); continue; }
		issues.push(`${at}.type ${type} is unsupported`);
	}
	unique(ids, "comparison.acceptance.rules", issues); if (rules.length === 0) issues.push("comparison.acceptance.rules must not be empty in gated mode"); return { mode: "gated", rules };
}

export async function loadComparison(file: string): Promise<{ comparison: Comparison; suite: Suite; warnings: string[] }> {
	const absolute = path.resolve(file); const issues: string[] = []; let root: Obj;
	try { root = object(parse(await readFile(absolute, "utf8")), "comparison", issues); } catch (error) { throw new ValidationError([`Cannot parse comparison ${absolute}: ${error instanceof Error ? error.message : String(error)}`]); }
	strict(root, ["schemaVersion", "kind", "name", "suite", "arms", "change", "hypotheses", "nonGoals", "execution", "acceptance"], "comparison", issues);
	if (root.schemaVersion !== 1) issues.push("comparison.schemaVersion must be 1"); if (root.kind !== "skill-eval-comparison") issues.push("comparison.kind must be skill-eval-comparison"); const comparisonName = text(root, "name", "comparison", issues) ?? "";
	const suiteRef = text(root, "suite", "comparison", issues) ?? ""; const suiteFile = path.resolve(path.dirname(absolute), suiteRef); let suite: Suite;
	try { await stat(suiteFile); suite = await loadSuite(suiteFile); } catch (error) { if (error instanceof ValidationError) throw error; throw new ValidationError([`Cannot load suite ${suiteFile}: ${error instanceof Error ? error.message : String(error)}`]); }
	const armsO = object(root.arms, "comparison.arms", issues); strict(armsO, ["control", "baseline", "candidate"], "comparison.arms", issues);
	const controlO = object(armsO.control, "comparison.arms.control", issues); strict(controlO, ["skill"], "comparison.arms.control", issues); if (controlO.skill !== "disabled") issues.push("comparison.arms.control.skill must be disabled");
	const baselineO = object(armsO.baseline, "comparison.arms.baseline", issues); strict(baselineO, ["ref"], "comparison.arms.baseline", issues); const baselineRef = text(baselineO, "ref", "comparison.arms.baseline", issues) ?? "";
	const candidateO = object(armsO.candidate, "comparison.arms.candidate", issues); strict(candidateO, ["ref", "snapshot"], "comparison.arms.candidate", issues); const candidateRef = text(candidateO, "ref", "comparison.arms.candidate", issues, true); let snapshot: { path: string } | undefined;
	if (candidateO.snapshot !== undefined) { const s = object(candidateO.snapshot, "comparison.arms.candidate.snapshot", issues); strict(s, ["path"], "comparison.arms.candidate.snapshot", issues); snapshot = { path: text(s, "path", "comparison.arms.candidate.snapshot", issues) ?? "" }; }
	if (Boolean(candidateRef) === Boolean(snapshot)) issues.push("comparison.arms.candidate requires exactly one of ref or snapshot");
	const changeO = object(root.change, "comparison.change", issues); strict(changeO, ["summary", "changelog"], "comparison.change", issues);
	const hypothesisItems = list(root.hypotheses, "comparison.hypotheses", issues); if (hypothesisItems.length === 0) issues.push("comparison.hypotheses must not be empty"); const hypotheses = hypothesisItems.map((item, index) => { const at = `comparison.hypotheses[${index}]`; const o = object(item, at, issues); strict(o, ["id", "expectedChange", "mustNotRegress", "scenarios"], at, issues); return { id: identifier(o, "id", at, issues), expectedChange: text(o, "expectedChange", at, issues) ?? "", mustNotRegress: strings(o.mustNotRegress, `${at}.mustNotRegress`, issues), scenarios: strings(o.scenarios, `${at}.scenarios`, issues) }; }); unique(hypotheses.map((h) => h.id), "comparison.hypotheses", issues);
	const executionO = object(root.execution, "comparison.execution", issues); strict(executionO, ["profile", "scenarios"], "comparison.execution", issues); const profile = text(executionO, "profile", "comparison.execution", issues) ?? "";
	const selectionO = object(executionO.scenarios, "comparison.execution.scenarios", issues); strict(selectionO, ["include", "all"], "comparison.execution.scenarios", issues); const include = selectionO.include === undefined ? undefined : strings(selectionO.include, "comparison.execution.scenarios.include", issues); const all = selectionO.all === true ? true : undefined; if (Boolean(include) === Boolean(all)) issues.push("comparison.execution.scenarios requires exactly one of include or all: true"); if (selectionO.all !== undefined && selectionO.all !== true) issues.push("comparison.execution.scenarios.all must be true");
	const selection = include ?? suite.scenarios.map((s) => s.id); unique(selection, "comparison.execution.scenarios.include", issues); const scenarioIds = new Set(suite.scenarios.map((s) => s.id)); selection.forEach((id) => { if (!scenarioIds.has(id)) issues.push(`Unknown selected scenario: ${id}`); }); hypotheses.flatMap((h) => h.scenarios).forEach((id) => { if (!scenarioIds.has(id)) issues.push(`Hypothesis references unknown scenario: ${id}`); });
	if (!suite.profiles[profile]) issues.push(`Unknown profile: ${profile}`);
	const comparison: Comparison = { schemaVersion: 1, kind: "skill-eval-comparison", name: comparisonName, file: absolute, suite: suiteFile, arms: { control: { skill: "disabled" }, baseline: { ref: baselineRef }, candidate: candidateRef ? { ref: candidateRef } : { snapshot } }, change: { summary: text(changeO, "summary", "comparison.change", issues) ?? "", changelog: text(changeO, "changelog", "comparison.change", issues, true) }, hypotheses, nonGoals: root.nonGoals === undefined ? [] : strings(root.nonGoals, "comparison.nonGoals", issues, true), execution: { profile, scenarios: include ? { include } : { all: true } }, acceptance: acceptance(root.acceptance, issues) };
	const warnings: string[] = []; for (const hypothesis of hypotheses) for (const id of hypothesis.scenarios) if (!selection.includes(id)) warnings.push(`Hypothesis ${hypothesis.id} references unselected scenario ${id}`);
	for (const scenario of suite.scenarios.filter((s) => selection.includes(s.id))) { if (scenario.invocation === "explicit" && scenario.runOn.includes("control")) warnings.push(`Explicit scenario ${scenario.id} includes control`); if (scenario.invocation === "forbidden" && scenario.runOn.includes("control")) warnings.push(`Forbidden scenario ${scenario.id} includes control, which rarely supplies activation evidence`); }
	if (issues.length) throw new ValidationError(issues); return { comparison, suite, warnings };
}
