---
name: skill-eval-creator
description: Create or review YAML evaluations for the simplified Pi skill-eval harness. Use when defining an eval goal, designing prompt variants, choosing an agent configuration, preparing whole-file replacements, or writing an eval YAML file.
---

# Skill Eval Creator

Create small, reviewable eval definitions for `/skill-eval`.

The eval YAML describes one Pi agent configuration running sequentially against independent user-message variants. It prepares one common workspace baseline and retains evidence for later human or agent analysis; it does not encode semantic grading.

## Source of truth

Before authoring, read the package's current format documentation relative to this skill:

```text
../../docs/skill-evaluation.md
```

When operating inside the `pise-en-place` source repository, also inspect:

```text
../../extensions/evals/skill-eval/config.ts
```

The implemented schema wins over examples or planned features. Do not add fields that the current validator does not support.

A starter file is available at:

```text
assets/eval.yaml
```

The optional reviewer-rubric template is owned by the sibling reviewer skill:

```text
../skill-eval-reviewer/assets/review-rubric.yaml
```

Resolve these paths relative to this skill directory, not the user's current working directory.

## Authoring workflow

### 1. Establish the evaluation goal

Identify:

- the behavior or decision being evaluated;
- the workspace Pi should operate in;
- the observable evidence expected from the session;
- whether the agent should edit files, answer only, or choose based on project guidance;
- any common files that must be replaced or removed before every variant;
- observable expected and prohibited outcomes that a later reviewer should apply.

Do not invent automated grading or numeric scores. Offer an optional same-basename reviewer sidecar so a later reviewer can apply authored expectations to the retained response, transcript, tool calls, metrics, and Git-visible changes. The execution harness never submits the sidecar to the evaluated agent. If expectation secrecy matters, recommend storing the eval and sidecar outside the evaluated workspace because ordinary copied workspace files remain discoverable to tools.

### 2. Choose the destination

If the user did not specify an eval YAML path, ask where to create it. Do not impose an `evals/` or `.pi/evals/` convention.

Resolve path semantics from the eventual YAML location:

- `workspace` is relative to the YAML, unless absolute;
- replacement `source` is relative to the YAML;
- replacement `target` is relative to the workspace.

### 3. Inspect narrowly

Read only enough of the target workspace and its guidance to write realistic prompts:

- relevant `AGENTS.md` files;
- files or documentation that define the behavior under evaluation;
- existing nearby evals, when present;
- replacement source files, when requested.

Do not modify the target workspace while investigating. Do not run builds, setup commands, or model-backed eval runs unless separately requested.

### 4. Define the agent configuration

The required agent fields are:

- `harness: pi`;
- one explicit `provider/model` identifier.

`thinking`, `tools`, and `limits` are optional. `limits.onTimeout` defaults to `stop`; use `continue` to run later variants after a timeout, or `retry` with `maxRetries` to retry a timed-out variant from its prepared baseline. Ask when the user has not supplied a required model or when tool access or timeout behavior materially affects the eval.

Use an explicit tool allowlist when tool usage is part of the evaluation contract. Otherwise, omitting `tools` uses Pi's normal defaults.

Skills are not listed in YAML. Pi discovers skills, extensions, settings, prompts, and context files from the prepared workspace and normal global resources.

### 5. Propose prompt variants

When the user supplies only a goal, propose 2–5 variants. Each variant should test a meaningfully different case, not paraphrase the same request.

Good dimensions include:

- allowed versus prohibited behavior;
- obvious versus ambiguous project guidance;
- edit request versus explanation-only request;
- local implementation versus shared abstraction;
- expected no-change outcome versus expected Git-visible change.

Every variant prompt is one ordinary user message to Pi. Write it as the request a user would actually send. Do not use it to append to or replace the system prompt, `AGENTS.md`, or other context.

Variant prompts must be independent. Do not refer to earlier variants or assume shared conversation history.

Use stable lowercase kebab-case variant names that communicate the scenario.

### 6. Use baseline setup sparingly

A replacement is a global whole-file copy applied before every variant. A removal is a global file deletion applied before every variant. Use either only when the common baseline needs to differ from the source workspace.

For each replacement:

- ensure `source` points to an existing file relative to the YAML;
- keep `target` inside the workspace;
- remember that missing targets and parent directories are allowed;
- avoid duplicate targets unless ordered overwrite behavior is deliberate;
- create a new source fixture only when the user has approved it.

For each removal:

- provide a workspace-relative target under `removals`;
- target files or symlinks only; a missing target is allowed, but directories are rejected;
- avoid listing a target also used by a replacement.

Do not encode patches, setup commands, text substitutions, or per-variant setup.

### 7. Confirm before writing

Present a concise proposal containing:

- destination YAML path;
- resolved workspace path;
- model, thinking level, and tools;
- proposed variants with one-line intent;
- replacement and removal files, if any;
- whether to create the optional `<eval-basename>.review.yaml` sidecar;
- files that will be created or changed.

Ask for confirmation before writing. Incorporate requested changes, then create the YAML, approved replacement source files, and approved reviewer sidecar.

### 8. Review the result

Before reporting completion, verify:

- only fields supported by the current schema are present;
- required strings are nonblank;
- the workspace resolves to an existing directory;
- every replacement source exists;
- replacement and removal targets are relative and cannot escape the workspace;
- every variant has a distinct inline prompt;
- prompts are ordinary user messages rather than hidden grading instructions;
- an optional review sidecar uses the same basename and extension as the eval, references only existing variant IDs, and states observable expectations rather than implementation-prescriptive hidden prompts;
- YAML parses without duplicate keys;
- source and target path comments, if included, remain accurate.

Do not claim model or tool availability was validated; `/skill-eval validate` intentionally does not check them. It does discover and validate a same-basename review sidecar when present.

### 9. Hand off validation

Report the created files and give the exact command:

```text
/skill-eval validate <path-to-eval.yaml>
```

Do not run `/skill-eval run` or otherwise spend eval model tokens unless the user separately asks to execute the eval.

## Reviewing an existing eval

When asked to review rather than create:

1. Read the current schema documentation.
2. Resolve all paths from the YAML location.
3. Check schema compatibility and source-file existence.
4. Assess whether variants are independent and meaningfully distinct.
5. Identify assumptions or duplicated scenarios.
6. Propose changes before editing unless the user explicitly requested edits.

Keep schema validity separate from eval quality: a valid YAML file can still contain weak or redundant prompts.

## Output style

Keep proposals concise. Prefer a small table for variants and a fenced YAML draft. Clearly distinguish:

- what is already specified;
- what you recommend;
- what files you will write after confirmation;
- what remains for later outcome analysis.
