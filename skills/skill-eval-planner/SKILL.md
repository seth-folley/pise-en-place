---
name: skill-eval-planner
description: Create, review, and update reusable agent-skill evaluation suites and release-specific comparison plans. Use when translating skill diffs, changelogs, regressions, or desired behavior into hypotheses, scenarios, fixtures, checks, rubrics, harness/model profiles, and acceptance rules.
---

# Skill Eval Planner

Design evaluation plans; do not run evaluations or update installed skills.

## Start by classifying the request

Choose the applicable workflow:

1. **Create a suite** for enduring scenarios and grading.
2. **Create a comparison** for one baseline-to-candidate update.
3. **Review** an existing suite or comparison for gaps and bias.
4. **Update a suite** with a regression case or newly observed failure.

Read [`references/authoring-guide.md`](references/authoring-guide.md) before creating or substantially restructuring files. When writing files, start from the bundled templates rather than recreating their shape:

- [`templates/suite.yaml`](templates/suite.yaml)
- [`templates/comparison.yaml`](templates/comparison.yaml)

## Clarify critical inputs

Before writing, inspect the skill, nearby eval files, repository guidance, diff, and changelog when available. Ask concise questions only for critical information that is still missing:

- Skill identity, source, and path.
- Whether the request is for a reusable suite, a release comparison, or both.
- Baseline ref and candidate ref or explicit local snapshot for a comparison.
- The behavior expected to improve and the behavior that must not regress.
- Fixture strategy when the repository does not make it evident.
- Any required harnesses, models, permissions, or release gates that differ from project defaults.

Do not silently invent refs, release claims, ground truth, or acceptance thresholds. Do not ask again for information already supplied by the user, repository, diff, or changelog. Infer ordinary internal details and state noncritical assumptions concisely.

## Create or update a suite

A suite owns reusable evaluation assets. It should survive multiple skill releases.

1. Inspect the evaluated skill's `SKILL.md`, bundled references, scripts, and declared compatibility.
2. Check for an existing `evals/<skill-name>/suite.yaml` before creating a new suite.
3. Resolve local repositories, fixtures, prompt files, and setup scripts relative to `suite.yaml`. Resolve `skill.path` inside `skill.source.repository`, and point it to the directory containing `SKILL.md`, not to the file itself.
4. Select a small set of scenarios that expose important behavior:
   - explicit invocation
   - implicit invocation
   - realistic contextual invocation
   - forbidden or adjacent invocation
   - core task outcome
   - known regression or edge case
5. Prefer three to five high-signal scenarios initially. Grow toward 10–20 only from meaningful coverage needs and observed failures.
6. For every scenario, define the task, fixture, applicable arms, permissions, objective evidence, and any narrowly scoped qualitative rubric.
7. Prefer the milestone-1 deterministic check vocabulary. Propose a later custom grading script only when built-in checks cannot express a critical requirement; do not add it to milestone-1 acceptance.
8. Keep answer keys and evaluator-only data outside the agent's staged workspace.
9. Avoid scenarios that merely restate the skill or flatter the candidate change.

Do not place baseline/candidate refs or release-specific claims in the reusable suite.

## Create a comparison

A comparison owns one update decision.

1. Reference the existing suite instead of duplicating scenarios.
2. Define control, a committed baseline ref, and either a committed or explicitly snapshotted local candidate. Omit an arm only when the scenario semantics require it.
3. Resolve the change intent from the diff, changelog, issue, or user statement.
4. Write hypotheses with two parts:
   - a specific observable behavior expected to change
   - explicit outcomes or behaviors that must not regress
5. Map every hypothesis to suite scenario IDs.
6. If an important hypothesis has no credible scenario, add or propose a reusable scenario in the suite rather than weakening the hypothesis.
7. Select an execution profile and explicitly select scenarios. Do not patch suite-owned scenario definitions from the comparison.
8. Choose gated or exploratory acceptance explicitly. Use exploratory mode instead of inventing thresholds; keep gated rules focused on critical regressions and explainable, explicitly scoped thresholds.

## Review an existing plan

Review for correctness before style. Report findings by severity and cite file paths and scenario or hypothesis IDs.

Check that:

- Suite and comparison responsibilities are not mixed.
- Refs, fixture paths, prompt files, scripts, and scenario references resolve.
- Every release claim maps to evidence or is marked as a non-goal.
- Scenarios include positive and negative activation coverage where relevant.
- Candidate and baseline receive the same task and grading.
- The no-skill control is used when it can reveal whether the skill adds value.
- Deterministic checks verify outcomes and important process constraints.
- Rubrics do not override objective failures or reward verbosity.
- Ground truth is not visible inside the staged agent workspace.
- Permissions, network use, timeouts, repetitions, and cost limits are explicit or inherited from clear defaults.
- Critical regressions produce a gate or required human review.
- Secrets and credentials cannot enter durable artifacts.

If the schema is still evolving, distinguish schema-shape suggestions from evaluation-quality findings.

## Add a regression case

When updating a suite after a failure:

1. Preserve the original failing prompt and relevant environment facts when safe.
2. Minimize the fixture without removing the behavior that caused the failure.
3. Add the strongest deterministic assertion that would have caught it.
4. Add qualitative grading only for residual judgment.
5. Tag the scenario as a regression and link it to the motivating issue or run ID when available.
6. Run-on configuration should compare future candidates against both the baseline and control when meaningful.

## Finish

Summarize:

- Files created or changed.
- Hypotheses and scenarios added or reviewed.
- Critical assumptions made.
- Missing fixtures, graders, or decisions.
- Whether the plan is ready for validation, ready to run once a runner exists, or blocked.

Keep the summary concise. Do not claim the plan passed evaluation when only its structure was reviewed.
