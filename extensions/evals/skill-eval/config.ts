import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "typebox";
import { Errors } from "typebox/value";
import { parseDocument } from "yaml";

const nonEmptyString = Type.String({ minLength: 1 });
const thinkingLevel = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);

const replacementSchema = Type.Object({
	source: nonEmptyString,
	target: nonEmptyString,
}, { additionalProperties: false });

const removalSchema = nonEmptyString;

const variantSchema = Type.Object({
	prompt: nonEmptyString,
}, { additionalProperties: false });

const dialogPolicy = Type.Union([Type.Literal("interactive"), Type.Literal("auto-reject")]);
const timeoutPolicy = Type.Union([Type.Literal("stop"), Type.Literal("continue"), Type.Literal("retry")]);

const reviewVariantSchema = Type.Object({
	expected: Type.Array(nonEmptyString, { minItems: 1 }),
	prohibited: Type.Optional(Type.Array(nonEmptyString, { minItems: 1 })),
	evidenceHints: Type.Optional(Type.Array(nonEmptyString, { minItems: 1 })),
}, { additionalProperties: false });

export const skillEvalReviewRubricSchema = Type.Object({
	version: Type.Literal(1),
	objective: nonEmptyString,
	sharedExpectations: Type.Optional(Type.Array(nonEmptyString, { minItems: 1 })),
	variants: Type.Optional(Type.Record(Type.String(), reviewVariantSchema, { minProperties: 1 })),
}, { additionalProperties: false });

export type SkillEvalReviewRubric = Static<typeof skillEvalReviewRubricSchema>;

export const skillEvalSchema = Type.Object({
	version: Type.Literal(1),
	name: nonEmptyString,
	workspace: nonEmptyString,
	agent: Type.Object({
		harness: Type.Literal("pi"),
		model: nonEmptyString,
		thinking: Type.Optional(thinkingLevel),
		tools: Type.Optional(Type.Array(nonEmptyString, { minItems: 1, uniqueItems: true })),
	}, { additionalProperties: false }),
	replacements: Type.Optional(Type.Array(replacementSchema, { minItems: 1 })),
	removals: Type.Optional(Type.Array(removalSchema, { minItems: 1, uniqueItems: true })),
	limits: Type.Optional(Type.Object({
		timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
		onTimeout: Type.Optional(timeoutPolicy),
		maxRetries: Type.Optional(Type.Integer({ minimum: 1 })),
	}, { additionalProperties: false })),
	dialogs: Type.Optional(dialogPolicy),
	variants: Type.Record(Type.String(), variantSchema, { minProperties: 1 }),
}, { additionalProperties: false });

export type SkillEvalConfig = Static<typeof skillEvalSchema>;

export type NormalizedSkillEvalConfig = SkillEvalConfig & {
	limits: { timeoutSeconds: number; onTimeout: "stop" | "continue" | "retry"; maxRetries: number };
	dialogs: "interactive" | "auto-reject";
};

export interface ResolvedSkillEvalConfig {
	configPath: string;
	config: NormalizedSkillEvalConfig;
	workspacePath: string;
	replacements: Array<{ source: string; target: string; sourcePath: string; targetPath: string }>;
	removals: Array<{ target: string; targetPath: string }>;
	reviewRubric?: { rubricPath: string; rubric: SkillEvalReviewRubric };
}

export class SkillEvalConfigError extends Error {
	constructor(public readonly issues: string[]) {
		super(issues.join("\n"));
		this.name = "SkillEvalConfigError";
	}
}

function schemaIssues(schema: typeof skillEvalSchema | typeof skillEvalReviewRubricSchema, value: unknown, prefix = ""): string[] {
	return [...Errors(schema, value)].map((error) => {
		const pathPrefix = prefix ? `${prefix}` : "";
		const location = error.instancePath || "configuration";
		const extras = error.keyword === "additionalProperties"
			? `: ${(error.params.additionalProperties as string[]).join(", ")}`
			: "";
		return `${pathPrefix}${location} ${error.message}${extras}`;
	});
}

export function reviewRubricPathFor(configPath: string): string {
	const extension = path.extname(configPath);
	return extension === ".yaml" || extension === ".yml"
		? `${configPath.slice(0, -extension.length)}.review${extension}`
		: `${configPath}.review.yaml`;
}

async function parseYamlFile(file: string, label: string): Promise<unknown> {
	let source: string;
	try {
		source = await readFile(file, "utf8");
	} catch (error) {
		throw new SkillEvalConfigError([
			`Cannot read ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`,
		]);
	}
	const document = parseDocument(source, { uniqueKeys: true });
	if (document.errors.length > 0) {
		throw new SkillEvalConfigError(document.errors.map((error) => `${label} YAML: ${error.message}`));
	}
	try {
		return document.toJS({ maxAliasCount: 100 }) as unknown;
	} catch (error) {
		throw new SkillEvalConfigError([`${label} YAML: ${error instanceof Error ? error.message : String(error)}`]);
	}
}

function isAbsoluteOnAnyPlatform(value: string): boolean {
	return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function isFile(file: string): Promise<boolean> {
	try {
		return (await stat(file)).isFile();
	} catch {
		return false;
	}
}

async function isDirectory(directory: string): Promise<boolean> {
	try {
		return (await stat(directory)).isDirectory();
	} catch {
		return false;
	}
}

export async function loadSkillEvalConfig(configFile: string): Promise<ResolvedSkillEvalConfig> {
	const configPath = path.resolve(configFile);
	const value = await parseYamlFile(configPath, "eval");
	const issues = schemaIssues(skillEvalSchema, value);
	if (issues.length > 0) throw new SkillEvalConfigError(issues);
	const parsed = value as SkillEvalConfig;
	const config: NormalizedSkillEvalConfig = {
		...parsed,
		limits: {
			timeoutSeconds: parsed.limits?.timeoutSeconds ?? 300,
			onTimeout: parsed.limits?.onTimeout ?? "stop",
			maxRetries: parsed.limits?.maxRetries ?? (parsed.limits?.onTimeout === "retry" ? 1 : 0),
		},
		dialogs: parsed.dialogs ?? "interactive",
	};
	const configDirectory = path.dirname(configPath);

	for (const [field, value] of [
		["name", config.name],
		["workspace", config.workspace],
		["agent.model", config.agent.model],
	] as const) {
		if (!value.trim()) issues.push(`${field} must not be blank`);
	}
	for (const [name, variant] of Object.entries(config.variants)) {
		if (!name.trim()) issues.push("Variant names must not be blank");
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
			issues.push(`Variant name must be a filesystem-safe identifier: ${name || "<blank>"}`);
		}
		if (!variant.prompt.trim()) issues.push(`variants.${name || "<blank>"}.prompt must not be blank`);
	}
	for (const [index, tool] of (config.agent.tools ?? []).entries()) {
		if (!tool.trim()) issues.push(`agent.tools[${index}] must not be blank`);
	}
	if (parsed.limits?.maxRetries !== undefined && config.limits.onTimeout !== "retry") {
		issues.push("limits.maxRetries requires limits.onTimeout: retry");
	}

	const workspacePath = path.resolve(configDirectory, config.workspace);
	if (!await isDirectory(workspacePath)) issues.push(`Workspace directory does not exist: ${workspacePath}`);

	const replacements = [];
	for (const [index, replacement] of (config.replacements ?? []).entries()) {
		const label = `replacements[${index}]`;
		if (!replacement.source.trim()) issues.push(`${label}.source must not be blank`);
		if (!replacement.target.trim()) issues.push(`${label}.target must not be blank`);
		if (isAbsoluteOnAnyPlatform(replacement.source)) issues.push(`${label}.source must be relative to the eval YAML`);
		if (isAbsoluteOnAnyPlatform(replacement.target)) issues.push(`${label}.target must be relative to the workspace`);
		const sourcePath = path.resolve(configDirectory, replacement.source);
		const targetPath = path.resolve(workspacePath, replacement.target);
		if (!await isFile(sourcePath)) issues.push(`Replacement source file does not exist: ${sourcePath}`);
		if (!isInside(workspacePath, targetPath)) issues.push(`${label}.target escapes the workspace: ${replacement.target}`);
		replacements.push({ ...replacement, sourcePath, targetPath });
	}

	const removals = [];
	for (const [index, target] of (config.removals ?? []).entries()) {
		const label = `removals[${index}]`;
		if (!target.trim()) issues.push(`${label} must not be blank`);
		if (isAbsoluteOnAnyPlatform(target)) issues.push(`${label} must be relative to the workspace`);
		const targetPath = path.resolve(workspacePath, target);
		if (!isInside(workspacePath, targetPath)) issues.push(`${label} escapes the workspace: ${target}`);
		removals.push({ target, targetPath });
	}

	let reviewRubric: ResolvedSkillEvalConfig["reviewRubric"];
	const rubricPath = reviewRubricPathFor(configPath);
	if (await isFile(rubricPath)) {
		const rubricValue = await parseYamlFile(rubricPath, "review rubric");
		issues.push(...schemaIssues(skillEvalReviewRubricSchema, rubricValue, "review rubric "));
		if (issues.length === 0) {
			const rubric = rubricValue as SkillEvalReviewRubric;
			if (!rubric.objective.trim()) issues.push("review rubric objective must not be blank");
			for (const [index, expectation] of (rubric.sharedExpectations ?? []).entries()) {
				if (!expectation.trim()) issues.push(`review rubric sharedExpectations[${index}] must not be blank`);
			}
			for (const [variantId, variant] of Object.entries(rubric.variants ?? {})) {
				if (!(variantId in config.variants)) issues.push(`review rubric references unknown variant: ${variantId}`);
				for (const [field, values] of Object.entries(variant) as Array<[keyof typeof variant, string[] | undefined]>) {
					for (const [index, item] of (values ?? []).entries()) {
						if (!item.trim()) issues.push(`review rubric variants.${variantId}.${field}[${index}] must not be blank`);
					}
				}
			}
			reviewRubric = { rubricPath, rubric };
		}
	}

	if (issues.length > 0) throw new SkillEvalConfigError(issues);
	return { configPath, config, workspacePath, replacements, removals, reviewRubric };
}
