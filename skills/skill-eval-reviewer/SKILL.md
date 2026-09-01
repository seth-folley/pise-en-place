---
name: skill-eval-reviewer
description: Review completed or partial Pi skill-eval runs using retained evidence, an optional authored rubric sidecar, a common ordinal rubric, and a deterministic HTML report. Use when asked to review, analyze, judge, or summarize a skill-eval run.
---

# Skill Eval Reviewer

Perform a read-only semantic review of a retained `/skill-eval run`. Produce versioned structured analysis and a deterministic shared HTML report. Never modify the evaluated source workspace or canonical run evidence.

## Assets

Resolve these paths relative to this skill directory:

```text
references/common-rubric.md
assets/review.schema.json
assets/review-template.html
assets/review-rubric.yaml
scripts/render-review.mjs
```

Read `references/common-rubric.md` completely before reviewing. Read `assets/review.schema.json` before writing output. The renderer validates additional invariants and HTML-escapes all review content.

## Invocation and run selection

The user should supply a retained run directory under `~/.pi/agent/skill-evals/`. Accept an exact path or run ID. If the user says “latest,” inspect directory names and report which run was selected. If multiple paths are plausible, ask instead of guessing.

A run may be completed, partial, timed out, cancelled, policy-stopped, interaction-blocked, or affected by a harness error. All are reviewable when evidence exists.

## Evidence boundary

Use retained artifacts inside the selected run directory by default. Do not silently inspect the current source workspace, Git repository, original eval location, network, or other mutable external state.

If retained evidence is insufficient:

- identify the exact gap;
- mark affected findings `inconclusive`;
- lower confidence;
- ask before consulting external context.

If the user explicitly authorizes external context, disclose it in `limitations`. Do not represent that review as artifacts-only; the V1 JSON contract is specifically for `retained_artifacts`, so discuss external findings in conversation unless the contract is revised.

Do not treat an existing `report.md` or `report.html` as more authoritative than canonical evidence. Do not treat assistant thinking as proof of correctness.

## Review workflow

### 1. Verify the run

Read:

1. `run.json`;
2. `eval.yaml`;
3. `review-rubric.yaml` when `run.json` marks it complete;
4. `resolved-config.json`;
5. `replacements.json` and `events.jsonl` as needed.

Check artifact completeness and consistency. A missing optional rubric is not an evidence-integrity failure.

### 2. Establish expectations

When `review-rubric.yaml` exists:

- use its objective as authored ground truth;
- apply `sharedExpectations` to every started variant;
- apply matching `expected` and `prohibited` entries;
- use `evidenceHints` only to guide inspection.

When the sidecar is absent or omits a variant:

- infer the minimum expectations clearly implied by the prompt and retained project guidance;
- label each inferred expectation with `source: "inferred"`;
- use `objective.source: "inferred"` when the objective itself is inferred;
- avoid high confidence when intent is ambiguous.

Never invent hidden requirements after seeing the result.

### 3. Inspect each variant

Start with compact evidence:

- operational status and metrics in `run.json`;
- prompt in `eval.yaml` or `run.json`;
- `final-response.md`;
- `status.txt` and `diff.patch`;
- `tool-calls.jsonl`;
- `resources.json` and system-prompt evidence.

Read `transcript.md`, native session JSONL, and detailed lifecycle events when needed to resolve approach, timing, tool, retry, compaction, dialog, or evidence questions. Do not omit relevant contrary evidence merely because it appears only in a detailed artifact.

For every variant:

- assess authored and inferred expectations;
- assess all nine common criteria, using `not_applicable` where appropriate;
- distinguish operational status from semantic outcome;
- compare response claims with actual tools and patch;
- record strengths, concerns, and actionable recommendations;
- cite relative artifact paths and useful locators.

Every citation artifact path is relative to the run directory. Never use absolute paths or `..` in citations.

### 4. Apply verdict rules

Use only the ordinal statuses and rule-based outcomes in `references/common-rubric.md`. Never calculate a numeric score.

Operational failures do not mechanically determine semantic outcomes. A timed-out variant may have enough evidence to fail, partially meet, or remain inconclusive; explain which applies.

### 5. Write structured review evidence

Create a new private directory without replacing earlier reviews:

```text
<run>/reviews/<UTC-basic-timestamp>-<8-hex-random>/
```

Use a timestamp such as `20260821T204425Z`. Create the directory with mode `0700` and files with mode `0600`.

Write `review.json` matching `assets/review.schema.json`. Additional renderer requirements:

- `run.path` is the absolute selected run directory;
- every run variant appears exactly once and in run order;
- every variant has exactly one assessment for each common criterion ID;
- citations name existing files and remain lexically inside the run directory;
- metrics are copied exactly from retained evidence rather than recomputed or guessed;
- unavailable provider cost remains the string `unavailable`;
- the top-level run outcome follows the common rubric rather than averaging variants.

If current reviewer model metadata is unavailable, omit `reviewer` or the unavailable field rather than guessing.

### 6. Validate and render HTML

Run:

```text
node <skill-directory>/scripts/render-review.mjs \
  --input <review-directory>/review.json \
  --output <review-directory>/review.html
```

The renderer uses `assets/review-template.html` by default. If validation fails, fix `review.json` and rerun it. Do not hand-edit generated HTML.

The HTML report is self-contained, accessible, responsive, printable, light/dark aware, and contains summaries plus evidence links. It deliberately does not embed raw transcripts, tool-result bodies, or patches.

### 7. Report completion

Tell the user:

- overall outcome and confidence;
- one-line outcome per variant;
- important evidence limitations;
- exact `review.json` and `review.html` paths.

Keep the conversational summary concise; the HTML report is the durable detailed review.

## Rubric sidecar authoring convention

For an eval named:

```text
package-architecture.yaml
```

the optional sidecar is:

```text
package-architecture.review.yaml
```

For `.yml`, preserve that extension. The sidecar schema is strict:

```yaml
version: 1
objective: >
  State the behavior being evaluated.
sharedExpectations:
  - State an observable expectation shared by all variants.
variants:
  variant-id:
    expected:
      - State an observable required outcome.
    prohibited:
      - State an observable outcome that must not occur.
    evidenceHints:
      - Name likely evidence without prescribing agent behavior.
```

`objective` is required. Other sections are optional. Every sidecar variant ID must match the sibling eval. The sidecar is reviewer-only: the runner retains it as `review-rubric.yaml` but never submits it as a user, system, or context message to the evaluated agent. This is not a secrecy boundary when the author stores the sidecar inside the evaluated workspace, where ordinary copied files remain tool-discoverable.
