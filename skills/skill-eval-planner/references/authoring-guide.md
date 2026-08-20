# Eval Suite and Comparison Authoring Guide

Use this guide when creating, reviewing, or substantially restructuring skill evaluation plans.

## Boundary between files

| Concern | Suite | Comparison |
| --- | --- | --- |
| Skill name, source, path | Yes | Inherited |
| Scenarios and fixtures | Yes | Select only; no patches |
| Checks and rubrics | Yes | No overrides |
| Harness/model profiles | Yes | Select; CLI may explicitly override selection |
| Baseline ref and candidate ref/snapshot | No | Yes |
| Release diff and changelog context | No | Yes |
| Update hypothesis | No | Yes |
| Scenario-to-hypothesis mapping | No | Yes |
| Explicit execution scenario selection | No | Yes |
| Gated or exploratory acceptance mode | No | Yes |

Use a suite to describe how a skill is evaluated over time. Use a comparison to describe why two versions are being compared now.

## Path resolution

Resolve relative paths from the file that owns the field; do not assume they are relative to the process working directory:

| Field | Resolution base |
| --- | --- |
| `skill.source.repository` when local | Directory containing `suite.yaml` |
| `skill.path` | Inside the resolved skill source; it must name the skill directory containing `SKILL.md`, not the file itself |
| Local or Git `fixture.path` / `fixture.repository` | Directory containing `suite.yaml` |
| `promptFile` and fixture setup script | Directory containing `suite.yaml` |
| Comparison `suite` | Directory containing the comparison file |
| `arms.candidate.snapshot.path` | Directory containing the comparison file |

For example, in `evals/my-skill/suite.yaml`, a skill at `<workspace>/skill-under-test/SKILL.md` uses:

```yaml
skill:
  source:
    type: git
    repository: ../..
  path: skill-under-test
```

Before finishing, resolve every local path from its owning file and verify that skill paths point to directories containing `SKILL.md` and fixture paths point to the intended fixture roots.

## Recommended layout

```text
evals/
└── <skill-name>/
    ├── suite.yaml
    ├── prompts/
    ├── fixtures/
    ├── graders/
    └── comparisons/
        └── <baseline>-to-<candidate>.yaml
```

Keep short prompts inline. Use `prompts/` for long or shared prompts. Keep evaluator-only files outside fixtures staged for the agent. Milestone 1 does not support custom grading scripts; a later tightly controlled script check may use `graders/`.

## Hypothesis quality

A useful hypothesis combines movement and protection:

> The candidate will **[observable behavior expected to improve]** while preserving **[outcomes or behaviors that must not regress]**.

Good:

> The candidate identifies actor-isolation problems earlier and recommends narrower fixes, while preserving build success and avoiding unsafe annotations.

Weak:

> The candidate handles concurrency better.

Map release claims deliberately:

- Changed instruction with expected behavior impact: hypothesis plus scenario.
- Refactor intended to preserve behavior: regression hypothesis.
- Documentation-only change with no expected behavior impact: explicit non-goal or compatibility check.
- Unsupported or untestable claim: record the gap instead of inventing evidence.

## Scenario design

Each scenario should answer one focused question. Include enough context to be realistic without embedding the expected answer in the prompt.

### Invocation modes

- `explicit`: names or directly requests the skill; normally runs on baseline and candidate.
- `implicit`: clearly needs the capability without naming the skill; normally runs on all arms.
- `contextual`: includes realistic noise or a broader task; normally runs on all arms.
- `forbidden`: adjacent task where the skill should not activate; normally runs on baseline and candidate.

### Coverage balance

An initial suite should usually include:

1. One explicit activation case.
2. One implicit or contextual activation case.
3. One forbidden activation case.
4. One or two core outcome or regression cases.

Do not make all tasks easy enough that a strong model scores perfectly without the skill. The no-skill control should reveal whether the suite measures capability the skill can influence.

### Fixtures

Prefer:

- Small synthetic fixtures for exact, deterministic failures.
- Pinned real repositories for realism and varied project structure.
- Fresh disposable worktrees for every run.

A real-repository fixture should pin an immutable commit. Setup runs once per scenario before the prepared fixture is frozen and may be either a command or a suite-relative script. Setup network access must be explicit. Setup inherits the host environment and is therefore trusted host code; avoid unnecessary hidden local state even when private package credentials are required. Record licenses or redistribution constraints when copying fixture content.

Keep answer keys, expected reports, judge context, and private grading data outside the workspace exposed to the evaluated agent.

## Checks and rubrics

Use evidence in this order:

1. Deterministic outcome checks.
2. Deterministic process or trace checks.
3. Narrow qualitative rubric.
4. Blind comparison.
5. Human review for ambiguity or critical risk.

Milestone 1 check vocabulary:

- `command`: build, test, lint, or another verification command.
- `file-exists`: expected artifact exists.
- `file-contains`: expected or forbidden content.
- `git-diff`: allowed paths, forbidden patterns, change count, or cleanliness.
- `trace-command`: required or forbidden shell-command evidence with optional count bounds.

Milestone-1 expectations are strict:

- `command` requires `command` and `expect.exitCode`; optional `stdoutContains` and `stderrContains` are string arrays.
- `file-exists` requires `path`; `expect.exists` defaults to `true` when omitted.
- `file-contains` requires `path` and at least one `expect.contains` or `expect.notContains` string array.
- `git-diff` accepts `allowedPaths`, `requiredPaths`, `forbiddenPatterns`, and `maxFiles`.
- `trace-command` requires a command substring plus either `expect.called: at-least-once | never` or `expect.minCount`; `maxCount` is optional.

Every check explicitly declares `severity: critical` or `severity: advisory`. Later milestones may add `skill-activation`, `json-schema`, and a tightly controlled custom `script` escape hatch.

A rubric criterion should describe one observable quality. Avoid criteria such as “excellent response” or “good reasoning.” Do not reward length, confident tone, or repetition. A qualitative judge cannot override a failed deterministic check.

## Evaluation arms

Default arms:

```text
control   no evaluated skill
baseline  current trusted committed ref
candidate proposed committed ref or explicit local snapshot
```

A local candidate path belongs in `arms.candidate.snapshot.path`, resolves relative to the comparison, and is frozen before approval. Do not infer or silently substitute the current working tree.

Compare:

- Baseline versus control to measure current skill lift.
- Candidate versus control to measure candidate skill lift.
- Candidate versus baseline to measure update improvement.

An explicit invocation scenario may omit control. A forbidden invocation scenario may omit control because activation is impossible there, though outcome-only control data can still be useful.

## Profiles and repetition

Keep model matrices in reusable named profiles:

- `smoke`: one representative model per implemented harness, one repetition, critical scenarios.
- `standard`: representative cross-harness/model coverage, typically three repetitions.
- `exhaustive`: broader models, real repositories, and additional repetitions.

Every target names an exact model and thinking level. Profiles may set concurrency and an optional evaluation-cell cost cap; concurrency defaults to one. A comparison selects a default profile, and an explicit `/skill-eval run --profile` override is highlighted and frozen into the resolved plan. Profiles also own optional advisory-supervisor model and thinking configuration beginning in milestone 2; milestone 1 must not silently ignore configured supervisor behavior.

Record resolved harness versions and model IDs in results, not as assumptions in the authored plan. Schedule arms in seeded paired comparison blocks rather than consistently running candidate after baseline.

## Acceptance policy

Declare `acceptance.mode: gated` or `acceptance.mode: exploratory`. Use exploratory mode when evidence is being gathered and defensible thresholds do not yet exist; do not invent thresholds merely to make a comparison runnable.

For gated comparisons, prefer a few explainable, identified typed rules:

- All candidate critical deterministic checks pass.
- No paired critical candidate regression against baseline.
- Candidate pass rate remains above an explicit minimum.
- Pass-rate deltas versus baseline or control remain within explicit limits.
- Median time or cost deltas remain within explicit limits.

Numeric rules explicitly declare `scope: overall`, `scope: eachScenario`, or `scope: eachTarget`. Unsupported or qualitative rules fail validation in milestone 1. Skill lift versus control may be omitted from gated acceptance and reported informationally; the runner does not invent this policy.

Useful review triggers:

- Deterministic checks and judge disagree.
- Repetitions are flaky.
- Candidate does not beat control on tests intended to show skill value.
- Candidate requests broader permissions.
- A critical scenario changes behavior in an unexpected way.

## Review checklist

### Suite

- [ ] Skill identity and source are stable.
- [ ] Scenarios test behavior rather than wording.
- [ ] Positive and negative activation are covered where relevant.
- [ ] Fixtures are reproducible and pinned where remote.
- [ ] Ground truth is inaccessible to evaluated agents.
- [ ] Checks are deterministic where possible.
- [ ] Rubrics are narrow and observable.
- [ ] Profiles avoid unnecessary model-matrix explosion.
- [ ] Release-specific refs and claims are absent.

### Comparison

- [ ] Baseline ref and candidate ref or local snapshot are explicit.
- [ ] The change summary and changelog context are recorded when available; the controller computes the authoritative frozen-tree diff.
- [ ] Every hypothesis names improvement and non-regression behavior.
- [ ] Every hypothesis maps to existing scenario IDs.
- [ ] Missing scenarios are added to the suite, not embedded as one-off duplicates.
- [ ] Acceptance gates emphasize critical regressions.
- [ ] Thresholds are justified rather than invented.

## Common mistakes

- Copying the whole suite into every comparison.
- Writing scenarios after seeing candidate output and accepting candidate-specific quirks as ground truth.
- Using only explicit invocation prompts.
- Omitting negative controls and therefore missing overactivation.
- Letting the agent access the answer key.
- Treating an LLM judge as more authoritative than builds or tests.
- Using one aggregate score that hides critical regressions.
- Running only one lucky repository or one steered interactive chat.
- Embedding credentials or private transcripts in committed eval files.
- Claiming improvement when candidate and no-skill results are identical on an easy suite.
