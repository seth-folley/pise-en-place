#!/usr/bin/env node
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATE = path.resolve(HERE, "../assets/review-template.html");
const CRITERIA = [
  "outcome_correctness",
  "guidance_adherence",
  "investigation",
  "change_quality",
  "verification",
  "final_response",
  "efficiency",
  "safety_policy",
  "evidence_sufficiency",
];
const ASSESSMENTS = new Set(["met", "partially_met", "not_met", "inconclusive", "not_applicable"]);
const CONFIDENCE = new Set(["high", "medium", "low"]);
const VARIANT_OUTCOMES = new Set(["meets_expectations", "partially_meets_expectations", "does_not_meet_expectations", "inconclusive", "not_run"]);
const RUN_OUTCOMES = new Set(["meets_expectations", "mixed", "does_not_meet_expectations", "inconclusive", "not_run"]);

function usage() {
  return "Usage: node render-review.mjs --input <review.json> --output <review.html> [--template <template.html>]";
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(usage());
    result[key.slice(2)] = value;
  }
  if (!result.input || !result.output) throw new Error(usage());
  return result;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(`Invalid review.json: ${message}`);
}

function exactKeys(value, allowed, location) {
  for (const key of Object.keys(value)) assert(allowed.includes(key), `${location} contains unknown field ${key}`);
}

function text(value, location) {
  assert(typeof value === "string" && value.trim().length > 0, `${location} must be a nonblank string`);
}

function stringArray(value, location) {
  assert(Array.isArray(value), `${location} must be an array`);
  value.forEach((item, index) => text(item, `${location}[${index}]`));
}

function validateCitation(value, location) {
  assert(isObject(value), `${location} must be an object`);
  exactKeys(value, ["artifact", "locator", "description"], location);
  text(value.artifact, `${location}.artifact`);
  text(value.description, `${location}.description`);
  if (value.locator !== undefined) text(value.locator, `${location}.locator`);
  const normalized = value.artifact.replaceAll("\\", "/");
  assert(!path.posix.isAbsolute(normalized), `${location}.artifact must be relative to the run directory`);
  assert(!normalized.split("/").includes(".."), `${location}.artifact must not escape the run directory`);
}

function validateAssessment(value, location) {
  assert(ASSESSMENTS.has(value.status), `${location}.status is invalid`);
  text(value.finding, `${location}.finding`);
  assert(Array.isArray(value.citations), `${location}.citations must be an array`);
  value.citations.forEach((citation, index) => validateCitation(citation, `${location}.citations[${index}]`));
}

function validateOutcome(value, location, allowed) {
  assert(isObject(value), `${location} must be an object`);
  exactKeys(value, ["outcome", "confidence", "summary"], location);
  assert(allowed.has(value.outcome), `${location}.outcome is invalid`);
  assert(CONFIDENCE.has(value.confidence), `${location}.confidence is invalid`);
  text(value.summary, `${location}.summary`);
}

function validateMetrics(value, location) {
  assert(isObject(value), `${location} must be an object`);
  const fields = ["wallTimeMs", "activeTimeMs", "dialogWaitMs", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "cost", "toolCalls", "toolFailures", "changedFiles", "insertions", "deletions"];
  exactKeys(value, fields, location);
  for (const field of fields) assert(value[field] !== undefined, `${location}.${field} is required`);
  for (const field of ["wallTimeMs", "activeTimeMs", "dialogWaitMs", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "toolCalls", "toolFailures", "changedFiles", "insertions", "deletions"]) {
    assert(typeof value[field] === "number" && Number.isFinite(value[field]) && value[field] >= 0, `${location}.${field} must be a nonnegative number`);
  }
  assert(value.cost === "unavailable" || (typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0), `${location}.cost is invalid`);
}

export function validateReview(review) {
  assert(isObject(review), "root must be an object");
  exactKeys(review, ["version", "rubricVersion", "generatedAt", "reviewer", "run", "evidenceBoundary", "objective", "overall", "evidenceIntegrity", "variants", "crossVariant", "limitations"], "root");
  assert(review.version === 1, "version must be 1");
  assert(review.rubricVersion === 1, "rubricVersion must be 1");
  text(review.generatedAt, "generatedAt");
  assert(Number.isFinite(Date.parse(review.generatedAt)), "generatedAt must be an ISO-compatible timestamp");
  if (review.reviewer !== undefined) {
    assert(isObject(review.reviewer), "reviewer must be an object");
    exactKeys(review.reviewer, ["agent", "model"], "reviewer");
    if (review.reviewer.agent !== undefined) text(review.reviewer.agent, "reviewer.agent");
    if (review.reviewer.model !== undefined) text(review.reviewer.model, "reviewer.model");
  }
  assert(isObject(review.run), "run must be an object");
  exactKeys(review.run, ["id", "name", "operationalStatus", "path"], "run");
  for (const field of ["id", "name", "operationalStatus", "path"]) text(review.run[field], `run.${field}`);
  assert(path.isAbsolute(review.run.path), "run.path must be absolute");
  assert(review.evidenceBoundary === "retained_artifacts", "evidenceBoundary must be retained_artifacts");
  assert(isObject(review.objective), "objective must be an object");
  exactKeys(review.objective, ["text", "source"], "objective");
  text(review.objective.text, "objective.text");
  assert(review.objective.source === "authored" || review.objective.source === "inferred", "objective.source is invalid");
  validateOutcome(review.overall, "overall", RUN_OUTCOMES);
  assert(isObject(review.evidenceIntegrity), "evidenceIntegrity must be an object");
  exactKeys(review.evidenceIntegrity, ["status", "findings"], "evidenceIntegrity");
  assert(["complete", "partial", "insufficient"].includes(review.evidenceIntegrity.status), "evidenceIntegrity.status is invalid");
  stringArray(review.evidenceIntegrity.findings, "evidenceIntegrity.findings");
  assert(Array.isArray(review.variants), "variants must be an array");
  const variantIds = new Set();
  review.variants.forEach((variant, variantIndex) => {
    const location = `variants[${variantIndex}]`;
    assert(isObject(variant), `${location} must be an object`);
    exactKeys(variant, ["id", "executionStatus", "outcome", "confidence", "summary", "metrics", "expectations", "criteria", "strengths", "concerns", "recommendations"], location);
    text(variant.id, `${location}.id`);
    assert(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(variant.id), `${location}.id must be a filesystem-safe variant ID`);
    assert(!variantIds.has(variant.id), `${location}.id is duplicated`);
    variantIds.add(variant.id);
    text(variant.executionStatus, `${location}.executionStatus`);
    assert(VARIANT_OUTCOMES.has(variant.outcome), `${location}.outcome is invalid`);
    assert(CONFIDENCE.has(variant.confidence), `${location}.confidence is invalid`);
    text(variant.summary, `${location}.summary`);
    if (variant.metrics !== undefined) validateMetrics(variant.metrics, `${location}.metrics`);
    assert(Array.isArray(variant.expectations), `${location}.expectations must be an array`);
    variant.expectations.forEach((expectation, index) => {
      const itemLocation = `${location}.expectations[${index}]`;
      assert(isObject(expectation), `${itemLocation} must be an object`);
      exactKeys(expectation, ["type", "text", "source", "status", "finding", "citations"], itemLocation);
      assert(["expected", "prohibited", "shared"].includes(expectation.type), `${itemLocation}.type is invalid`);
      text(expectation.text, `${itemLocation}.text`);
      assert(expectation.source === "authored" || expectation.source === "inferred", `${itemLocation}.source is invalid`);
      validateAssessment(expectation, itemLocation);
    });
    assert(Array.isArray(variant.criteria), `${location}.criteria must be an array`);
    const criterionIds = new Set();
    variant.criteria.forEach((criterion, index) => {
      const itemLocation = `${location}.criteria[${index}]`;
      assert(isObject(criterion), `${itemLocation} must be an object`);
      exactKeys(criterion, ["id", "status", "finding", "citations"], itemLocation);
      assert(CRITERIA.includes(criterion.id), `${itemLocation}.id is invalid`);
      assert(!criterionIds.has(criterion.id), `${itemLocation}.id is duplicated`);
      criterionIds.add(criterion.id);
      validateAssessment(criterion, itemLocation);
    });
    for (const criterion of CRITERIA) assert(criterionIds.has(criterion), `${location}.criteria is missing ${criterion}`);
    stringArray(variant.strengths, `${location}.strengths`);
    stringArray(variant.concerns, `${location}.concerns`);
    stringArray(variant.recommendations, `${location}.recommendations`);
  });
  assert(isObject(review.crossVariant), "crossVariant must be an object");
  exactKeys(review.crossVariant, ["patterns", "recommendations"], "crossVariant");
  stringArray(review.crossVariant.patterns, "crossVariant.patterns");
  stringArray(review.crossVariant.recommendations, "crossVariant.recommendations");
  stringArray(review.limitations, "limitations");
  return review;
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function label(value) {
  return String(value).replaceAll("_", " ");
}

function badge(value) {
  return `<span class="badge ${escapeHtml(value)}">${escapeHtml(label(value))}</span>`;
}

function list(values, empty = "None recorded.") {
  return values.length > 0 ? `<ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>` : `<p class="empty">${escapeHtml(empty)}</p>`;
}

function artifactHref(outputPath, review, artifact) {
  const runRoot = path.resolve(review.run.path);
  const target = path.resolve(runRoot, artifact);
  assert(target === runRoot || target.startsWith(`${runRoot}${path.sep}`), `citation artifact escapes run directory: ${artifact}`);
  const relative = path.relative(path.dirname(path.resolve(outputPath)), target).split(path.sep).map(encodeURIComponent).join("/");
  return relative || ".";
}

function citations(items, outputPath, review) {
  if (items.length === 0) return "";
  return `<ul class="citations">${items.map((item) => {
    const locator = item.locator ? ` — ${escapeHtml(item.locator)}` : "";
    return `<li><a href="${escapeHtml(artifactHref(outputPath, review, item.artifact))}">${escapeHtml(item.artifact)}</a>${locator}: ${escapeHtml(item.description)}</li>`;
  }).join("")}</ul>`;
}

function assessmentTable(items, kind, outputPath, review) {
  if (items.length === 0) return `<p class="empty">No ${kind} recorded.</p>`;
  const firstHeading = kind === "expectations" ? "Expectation" : "Criterion";
  return `<table><thead><tr><th>${firstHeading}</th><th>Status</th><th>Finding and evidence</th></tr></thead><tbody>${items.map((item) => {
    const title = kind === "expectations"
      ? `<strong>${escapeHtml(item.text)}</strong><br><span class="muted">${escapeHtml(item.type)} · ${escapeHtml(item.source)}</span>`
      : `<code>${escapeHtml(label(item.id))}</code>`;
    return `<tr><td>${title}</td><td>${badge(item.status)}</td><td><p class="finding">${escapeHtml(item.finding)}</p>${citations(item.citations, outputPath, review)}</td></tr>`;
  }).join("")}</tbody></table>`;
}

function formatMs(value) {
  return `${(value / 1000).toFixed(2)}s`;
}

function metrics(value) {
  if (!value) return `<p class="empty">Metrics unavailable.</p>`;
  const entries = [
    [formatMs(value.activeTimeMs), "Active time"],
    [formatMs(value.wallTimeMs), "Wall time"],
    [formatMs(value.dialogWaitMs), "Dialog wait"],
    [value.cost === "unavailable" ? "unavailable" : `$${value.cost.toFixed(4)}`, "Provider cost"],
    [value.inputTokens, "Input tokens"],
    [value.outputTokens, "Output tokens"],
    [value.cacheReadTokens, "Cache-read tokens"],
    [value.cacheWriteTokens, "Cache-write tokens"],
    [value.toolCalls, "Tool calls"],
    [value.toolFailures, "Tool failures"],
    [value.changedFiles, "Changed files"],
    [`+${value.insertions} / -${value.deletions}`, "Diff lines"],
  ];
  return `<div class="metric-grid">${entries.map(([number, name]) => `<div class="metric"><strong>${escapeHtml(number)}</strong><span>${escapeHtml(name)}</span></div>`).join("")}</div>`;
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJsonValue(value[key])]));
}

function sameJsonValue(left, right) {
  return JSON.stringify(stableJsonValue(left)) === JSON.stringify(stableJsonValue(right));
}

async function validateAgainstRun(review, inputPath, outputPath) {
  const runRoot = path.resolve(review.run.path);
  const reviewsRoot = path.join(runRoot, "reviews");
  const resolvedInput = path.resolve(inputPath);
  const resolvedOutput = path.resolve(outputPath);
  assert(resolvedInput.startsWith(`${reviewsRoot}${path.sep}`), "review.json must be under <run>/reviews/<review-id>/");
  assert(path.dirname(resolvedInput) === path.dirname(resolvedOutput), "review.json and review.html must share one review directory");
  assert(path.basename(resolvedInput) === "review.json" && path.basename(resolvedOutput) === "review.html", "review output files must be named review.json and review.html");
  let run;
  try { run = JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8")); }
  catch (error) { throw new Error(`Cannot validate review against retained run.json: ${error.message}`); }
  assert(run.runId === review.run.id, "run.id does not match retained run.json");
  assert(run.name === review.run.name, "run.name does not match retained run.json");
  assert(run.status === review.run.operationalStatus, "run.operationalStatus does not match retained run.json");
  assert(Array.isArray(run.variants), "retained run.json variants are invalid");
  assert(run.variants.length === review.variants.length, "review must contain every retained run variant exactly once");
  run.variants.forEach((runVariant, index) => {
    const reviewed = review.variants[index];
    assert(reviewed.id === runVariant.id, `variants[${index}] must match retained run order and ID ${runVariant.id}`);
    assert(reviewed.executionStatus === runVariant.status, `variants[${index}].executionStatus does not match retained run.json`);
    if (runVariant.metrics === undefined) assert(reviewed.metrics === undefined, `variants[${index}].metrics must be omitted because retained metrics are unavailable`);
    else assert(sameJsonValue(reviewed.metrics, runVariant.metrics), `variants[${index}].metrics must exactly match retained run.json`);
  });
  const citedArtifacts = new Set(review.variants.flatMap((variant) => [...variant.expectations, ...variant.criteria].flatMap((item) => item.citations.map((citation) => citation.artifact))));
  for (const artifact of citedArtifacts) {
    const candidate = path.resolve(runRoot, artifact);
    let metadata;
    try { metadata = await stat(candidate); }
    catch { throw new Error(`Invalid review.json: cited artifact does not exist: ${artifact}`); }
    assert(metadata.isFile(), `cited artifact must be a file: ${artifact}`);
  }
}

export function renderReview(review, template, outputPath) {
  validateReview(review);
  assert(template.includes("{{TITLE}}") && template.includes("{{CONTENT}}"), "HTML template must contain {{TITLE}} and {{CONTENT}}");
  const metadata = [
    ["Run ID", review.run.id],
    ["Operational status", review.run.operationalStatus],
    ["Generated", review.generatedAt],
    ["Evidence boundary", review.evidenceBoundary],
    ["Objective source", review.objective.source],
    ["Reviewer", [review.reviewer?.agent, review.reviewer?.model].filter(Boolean).join(" · ") || "unavailable"],
    ["Run path", review.run.path],
  ];
  const variantSummary = review.variants.length > 0
    ? `<table><thead><tr><th>Variant</th><th>Execution</th><th>Semantic outcome</th><th>Confidence</th></tr></thead><tbody>${review.variants.map((variant) => `<tr><td><a href="#variant-${encodeURIComponent(variant.id)}">${escapeHtml(variant.id)}</a></td><td><code>${escapeHtml(variant.executionStatus)}</code></td><td>${badge(variant.outcome)}</td><td>${badge(variant.confidence)}</td></tr>`).join("")}</tbody></table>`
    : `<p class="empty">No variants recorded.</p>`;
  const variantSections = review.variants.map((variant) => `<section class="panel variant" id="variant-${escapeHtml(variant.id)}"><p class="eyebrow">Variant review</p><h2>${escapeHtml(variant.id)}</h2><div class="badges"><span class="badge">${escapeHtml(variant.executionStatus)}</span>${badge(variant.outcome)}${badge(variant.confidence)}</div><p class="summary">${escapeHtml(variant.summary)}</p><h3>Metrics</h3>${metrics(variant.metrics)}<h3>Expectations</h3>${assessmentTable(variant.expectations, "expectations", outputPath, review)}<h3>Common criteria</h3>${assessmentTable(variant.criteria, "criteria", outputPath, review)}<div class="columns"><div><h3>Strengths</h3>${list(variant.strengths)}</div><div><h3>Concerns</h3>${list(variant.concerns)}</div></div><h3>Recommendations</h3>${list(variant.recommendations)}</section>`).join("");
  const content = `<header><p class="eyebrow">Skill evaluation semantic review</p><h1>${escapeHtml(review.run.name)}</h1></header><div class="hero"><section class="panel"><div class="badges">${badge(review.overall.outcome)}${badge(review.overall.confidence)}</div><p class="summary">${escapeHtml(review.overall.summary)}</p><div class="callout"><strong>Objective:</strong> ${escapeHtml(review.objective.text)}</div></section><aside class="panel"><dl class="metadata">${metadata.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl></aside></div><section class="panel"><h2>Evidence integrity</h2><div class="badges">${badge(review.evidenceIntegrity.status)}</div>${list(review.evidenceIntegrity.findings, "No evidence-integrity findings.")}<h2>Variant summary</h2>${variantSummary}</section>${variantSections}<section class="panel"><h2>Cross-variant findings</h2><div class="columns"><div><h3>Patterns</h3>${list(review.crossVariant.patterns)}</div><div><h3>Recommendations</h3>${list(review.crossVariant.recommendations)}</div></div><h2>Review limitations</h2>${list(review.limitations, "No additional limitations recorded.")}</section><footer>Rubric version ${escapeHtml(review.rubricVersion)} · Structured source: <code>review.json</code> · Generated ${escapeHtml(review.generatedAt)}</footer>`;
  return template.replace("{{TITLE}}", escapeHtml(`${review.run.name} — skill eval review`)).replace("{{CONTENT}}", content);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  const outputPath = path.resolve(args.output);
  const templatePath = path.resolve(args.template ?? DEFAULT_TEMPLATE);
  const [source, template] = await Promise.all([readFile(inputPath, "utf8"), readFile(templatePath, "utf8")]);
  let review;
  try { review = JSON.parse(source); } catch (error) { throw new Error(`Invalid review.json: ${error.message}`); }
  validateReview(review);
  await validateAgainstRun(review, inputPath, outputPath);
  const html = renderReview(review, template, outputPath);
  await writeFile(outputPath, html, { mode: 0o600 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
