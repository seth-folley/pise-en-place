# Skill Evaluation Tool: Design Decisions

Status: milestone 1 implemented in source; real-provider smoke validation pending  
Last updated: 2026-08-20

This document records the design and implementation boundaries for repeatedly evaluating agent skill changes across Pi, Codex, Claude Code, and multiple models. It is the implementation reference; delegated engineering details are listed separately so they are not mistaken for unresolved product decisions.

The practical workflow is documented in the [`skill-evaluation-user-guide.html`](./skill-evaluation-user-guide.html) user guide. The visual architecture overview is available in [`skill-evaluation-plan.html`](./skill-evaluation-plan.html).

## Implementation handoff

The architecture, user-facing interface, safety posture, evaluation semantics, schemas, lifecycle, dashboard, and milestone boundaries are approved. Milestone 1 now has a durable Pi controller, strict authored-plan validation, frozen inputs, event-sourced state, fixture preparation, deterministic grading and acceptance, reports, controls, and monitor UI.

Before beginning milestone 2, exercise milestone 1 with an approved real-provider smoke suite and harden any execution or isolation failures it reveals. Do not add the advisory supervisor, Codex adapter, or Claude Code adapter until deterministic Pi execution, stale-run finalization, grading, and compact evidence are reliable in that smoke run.

## Goal

Given an existing skill version and a proposed update, answer:

> Does the skill add value, and does the update improve agent behavior without introducing important regressions?

The workflow must support plans authored by a person or an agent, execute those plans repeatably across multiple harnesses and models, and produce an auditable recommendation.

## Initial comparison candidates

The first concrete update comparisons motivating the runner are:

| Skill | Baseline | Candidate | Diff | Changelog |
| --- | --- | --- | --- | --- |
| `swift-concurrency` | `2.1.1` | `2.3.0` | [Compare](https://github.com/AvdLee/Swift-Concurrency-Agent-Skill/compare/2.1.1...2.3.0) | [2.3.0 release](https://github.com/AvdLee/Swift-Concurrency-Agent-Skill/releases/tag/2.3.0) |
| `swiftui-expert-skill` | `3.3.0` | `4.2.0` | [Compare](https://github.com/AvdLee/SwiftUI-Agent-Skill/compare/3.3.0...4.2.0) | [4.2.0 release](https://github.com/AvdLee/SwiftUI-Agent-Skill/releases/tag/4.2.0) |

These are candidate evaluation inputs, not authorization to update the installed skills or execute a run. Each still needs an authored suite/comparison and explicit approval through `/skill-eval run`.

## Agreed decisions

### Evaluation scope

- Initial harness scope: Pi, Codex, and Claude Code.
- Compare a committed baseline Git ref with either a committed candidate ref or an explicitly configured local candidate snapshot. Local candidate snapshots are a first-class requirement because the initial workflow is iterative skill refinement before committing.
- Include a no-skill control when applicable.
- Use both synthetic fixtures and representative real repositories.
- Capture a human-readable report, machine-readable JSON, and redacted raw transcripts and traces.
- Keep evaluation offline and development-time. Runtime validation or response blocking is a guardrail and is outside this tool's scope.

### Experimental model

Each applicable scenario has three arms:

1. **Control:** no evaluated skill is available.
2. **Baseline:** the current skill version is available.
3. **Candidate:** the proposed skill version is available.

The task, model, harness, fixture, permissions, and grading remain constant. Only the skill arm changes.

This provides two distinct comparisons:

- **Skill lift:** baseline or candidate versus no skill.
- **Update improvement:** candidate versus baseline.

Explicit-invocation scenarios may omit the no-skill arm because the requested skill is intentionally unavailable there. Negative-activation scenarios normally run only against skill-bearing arms.

### Hypotheses

Every comparison states:

- The observable behavior expected to improve.
- The behavior or outcome that must not regress.
- The suite scenarios that supply evidence for the hypothesis.

Example:

```yaml
hypotheses:
  - id: improved-isolation-diagnosis
    expectedChange: >
      The candidate identifies actor-isolation problems more reliably
      and recommends narrower, safer fixes.
    mustNotRegress:
      - The project builds and tests pass.
      - The agent does not suppress concurrency safety.
      - MainActor is not applied more broadly than necessary.
    scenarios:
      - diagnose-mainactor-capture
```

A release-note or diff claim should become a hypothesis or an explicit non-goal. “Better” without an observable behavior is not an adequate hypothesis.

### Reusable suites and release-specific comparisons

Evaluation content is split into two concepts.

#### Suite

A suite is the reusable test asset for a skill. It owns:

- Skill identity and source.
- Scenarios and fixtures.
- Prompts.
- Deterministic checks.
- Qualitative rubrics.
- Shared defaults.
- Named harness/model profiles.

Suites evolve as real failures and regressions are discovered.

#### Comparison

A comparison represents one proposed update. It owns:

- A committed baseline ref and a committed or local-snapshot candidate.
- Optional no-skill control configuration.
- Change summary, diff, and changelog links.
- Update-specific hypotheses.
- Hypothesis-to-scenario evidence mappings.
- Explicit execution scenario selection.
- Execution profile selection or overrides.
- Acceptance policy.

This avoids copying the enduring scenario suite for every release while preserving an auditable record of why a particular update was evaluated.

### Suggested repository layout

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

Prompts may remain inline for short scenarios. Larger prompts belong under `prompts/`. Custom deterministic grading scripts, when necessary, belong under `graders/`.

### Scenario coverage

The suite should cover these invocation modes:

- **Explicit:** the prompt names the skill.
- **Implicit:** the prompt clearly needs the skill without naming it.
- **Contextual:** the skill is relevant inside a realistic, noisier request.
- **Forbidden:** an adjacent task where the skill should not activate.

The MVP may begin with three to five focused scenarios. A mature suite should generally grow toward 10–20 targeted prompts, driven by observed failures rather than arbitrary benchmark size.

A scenario includes:

- Stable ID, title, purpose, and capability tags.
- Prompt and fixture.
- Invocation mode.
- Applicable evaluation arms.
- Permissions and timeout overrides.
- Deterministic checks.
- Optional qualitative rubric.
- Criticality or regression severity.

Illustrative shape:

```yaml
scenarios:
  - id: diagnose-mainactor-capture
    title: Diagnose a MainActor isolation error
    covers: [actor-isolation, diagnosis, minimal-fix]
    purpose: Test implicit activation and diagnosis quality.
    prompt: |
      This project produces a Swift 6 concurrency error.
      Diagnose it and implement the smallest safe, idiomatic fix.
    fixture:
      type: local
      path: fixtures/mainactor-capture
    invocation: implicit
    runOn: [control, baseline, candidate]
    permissions:
      mode: workspace-write
      network: false
    checks:
      - id: project-builds
        type: command
        severity: critical
        command: swift build
        expect:
          exitCode: 0
    rubric:
      - id: diagnosis
        description: Correctly explains the actor-isolation boundary.
        weight: 3
```

This shape reflects the settled authored-plan direction. Fine-grained expectation payloads for the focused check types still need to be finalized during schema implementation.

### Grading order

Grading uses four conceptual responsibilities:

1. **Executor:** runs the task headlessly and captures traces and artifacts.
2. **Grader:** applies deterministic checks, then any qualitative rubric.
3. **Comparator:** performs a blind comparison without knowing which arm produced each result.
4. **Analyzer:** identifies cross-run and cross-harness patterns hidden by aggregate scores.

Deterministic evidence takes priority. A model judge cannot turn a failed build, failed test, forbidden edit, or policy violation into a passing result.

Human review is required or recommended when:

- A critical scenario regresses.
- Deterministic checks and qualitative judgment disagree.
- Judges disagree materially.
- Results are flaky.
- Security-sensitive or destructive behavior occurs.

### Initial deterministic check vocabulary

Milestone 1 implements a focused, understandable core:

- `command`: run a build, test, lint, or other verification command.
- `file-exists`: verify that an expected artifact exists.
- `file-contains`: inspect generated content.
- `git-diff`: validate change scope, forbidden patterns, and repository cleanliness.
- `trace-command`: verify that a command substring was run or avoided, with optional minimum and maximum counts. Ordered trace assertions are deferred.

Every deterministic check must explicitly declare `severity: critical` or `severity: advisory`; there is no consequential default. A cell passes when every critical check passes. Advisory failures remain visible without changing deterministic pass status.

Later milestones may add `skill-activation`, `json-schema`, and a tightly controlled custom `script` escape hatch. Custom scripts are deferred because they are harder to audit, secure, and transport between repositories.

### Isolation and experimental integrity

Every run should use:

- A fresh temporary home or equivalent isolated harness configuration.
- A fresh fixture checkout or worktree.
- No evaluated skill, or exactly one frozen evaluated skill version.
- Suppressed ambient skills, extensions, prompt templates, and host context files.
- Fixture-owned `AGENTS.md` and `CLAUDE.md` context, discovered only inside the frozen fixture and injected explicitly in normal hierarchical order.
- Fixed prompts and noninteractive/headless execution.
- An explicit tool allowlist inherited from suite defaults and replaceable per scenario.
- Best-effort workspace and network isolation, with the achieved `isolationLevel` recorded on every result and clearly warned about before execution.
- Explicit time and optional cost limits.
- Blocked remote pushes.
- An answer key and grading data outside the agent's accessible workspace.

An optional ambient suite may later test interactions with normal global configuration. Ambient results must remain separate from controlled results.

### Repetitions and run profiles

Named profiles keep routine evaluations affordable:

- **Smoke:** one representative model per harness, one repetition, and a small critical scenario set.
- **Standard:** representative model coverage with three repetitions of nondeterministic scenarios.
- **Exhaustive:** broader model coverage, additional real repositories, and more repetitions for high-risk releases.

Runs should alternate or randomize arm order across repetitions to reduce ordering and time-based bias. Reports show pass rates and flakiness rather than hiding variation behind one average.

### Results and acceptance

The report must distinguish:

- Skill lift versus the no-skill control.
- Candidate change versus baseline.
- Critical regressions.
- Activation behavior.
- Per-harness and per-model results.
- Flaky scenarios.
- Time, turns, token usage, infrastructure errors, and estimated cost where available. Cells are not retried automatically.

Execution lifecycle and evaluation verdict are separate. A successfully completed evaluation may prove that the candidate fails; a controller failure may leave the candidate inconclusive.

Deterministic verdicts are:

- `pending`
- `pass`
- `fail`
- `incomplete`
- `informational`

A comparison must declare `acceptance.mode: gated` or `acceptance.mode: exploratory`. A complete exploratory run produces `informational`; missing required cells still produce `incomplete`. Exploratory runs report critical failures and deterministic deltas as evidence but reject acceptance rules rather than pretending to evaluate them.

Gated acceptance rules use three-valued results: `pass`, `fail`, or `not_evaluated`. Overall precedence is:

1. Any definitive gate failure produces `fail`, even if other evidence is missing.
2. Otherwise, missing required evidence produces `incomplete`.
3. Otherwise, all required gates passing produces `pass`.

Milestone 1 supports required-cell completeness, candidate critical checks, paired critical regressions, candidate pass-rate thresholds, pass-rate deltas versus baseline and control, and observed median cost/time limits or deltas. Numeric rules explicitly declare an aggregation scope of `overall`, `eachScenario`, or `eachTarget`. Unsupported acceptance rules fail validation rather than being silently omitted. Critical gates matter more than one aggregate score.

Every result is pinned to:

- Resolved skill commits.
- Suite and comparison content hashes.
- Exact harness versions.
- Resolved model IDs.
- Relevant environment metadata.

This permits later reruns to detect model or harness drift.

### Report artifacts

Authoritative private artifacts live outside evaluated repositories:

```text
~/.pi/agent/skill-evals/
├── registry.json
└── runs/<run-id>/
    ├── events.jsonl
    ├── state.json
    ├── controller.json
    ├── resolved-plan.json
    ├── control/
    ├── cells/
    ├── supervisor/
    └── reports/
        ├── report.md
        └── report.json
```

Milestone 1 retains runs until explicit deletion. Completed runs keep a compact audit bundle: frozen skill inputs, fixture provenance and setup definition, relevant diffs and generated evidence files, check results, redacted traces, and reports. Disposable workspaces and dependency trees are deleted after evidence capture. HTML and explicit report export follow later.

Transcripts and traces must be redacted before durable storage. Credentials and unredacted secrets must never appear in report artifacts.

## Selected architecture

The selected architecture is a **Pi-controlled runner with a deterministic controller and a checkpoint-driven advisory supervisor**:

1. `skills/skill-eval-planner/` helps a person or agent author suites and comparisons.
2. A Pi extension is the only supported user-facing entry point. There is no standalone CLI or agent-facing runner tool initially.
3. A detached, non-LLM TypeScript worker owns objective execution and survives turns, session switches, `/reload`, and Pi exiting.
4. Pi, Codex, and Claude Code are evaluation targets behind narrow adapters, but milestone 1 implements only Pi and fails validation if a selected profile includes an unsupported harness.
5. A separate Pi supervisor interprets normalized evidence at checkpoints. It never monitors processes, grades deterministic checks, changes plans or thresholds, retries cells, or controls the run.

Only one top-level evaluation may run globally at a time. The worker may execute multiple cells within that run according to profile concurrency.

### Component boundaries

```text
Pi /skill-eval command and picker
    ├── validation, approval, startup notification, status, and monitor UI
    └── detached deterministic controller
            ├── schema and resolved-plan validation
            ├── global lock, queue, budgets, and run-state persistence
            ├── fixture preparation and isolated workspace manager
            ├── Pi adapter initially; Codex and Claude Code later
            ├── deterministic graders
            ├── compact artifact and report generator
            └── checkpoint-triggered advisory Pi processes
```

Harness-specific behavior remains behind an adapter contract that validates capabilities, executes and cancels a cell, captures structured evidence, and normalizes errors and usage.

## Authored-plan decisions

### Validation, defaults, and resolution

Authored suite and comparison YAML uses strict, versioned schemas. Unknown fields fail validation at every level; an optional `metadata` object is the deliberate escape hatch for non-execution annotations. Milestone 1 accepts only the exact schema versions it implements rather than silently migrating or ignoring fields.

Defaulting is limited to conservative operational values:

- Repetitions default to `1`.
- Maximum cell concurrency defaults to `1`.
- Agent and fixture-setup network access default to disabled.
- Automatic retries and fail-fast behavior are disabled.
- Cost is uncapped unless the evaluation profile explicitly sets `maxCost`.
- Runner fallback timeouts are 15 minutes for fixture setup, 20 minutes for an evaluated cell, and 10 minutes for each deterministic check. Suites and scenarios may explicitly override them.

Models, thinking levels, scenario selection, arm refs, local candidate paths, check severities, and gated acceptance thresholds never receive inferred defaults. Suite defaults merge field-by-field for permissions and limits; scenario tool arrays replace rather than merge the suite tool list.

A comparison cannot patch suite-owned prompts, fixtures, checks, rubrics, tools, permissions, or limits in milestone 1. It selects scenarios, arms, hypotheses, acceptance, and a default profile. `/skill-eval run --profile <name>` may explicitly override that profile selection, but Pi highlights the override during approval and records it in the resolved plan.

Before approval, the controller computes the authoritative baseline-to-candidate diff from the frozen skill trees. Authored changelog or supplemental-diff references are contextual only. `resolved-plan.json` stores the complete ordered block and cell matrix, concrete defaults, versions, digests, seed, permissions, acceptance rules, and artifact references. Prompt bodies and snapshots remain in content-addressed private artifacts instead of the plan or event ledger. The resolved plan is immutable after approval; prepared-fixture digests and other execution facts are runtime events and artifacts.

### Scenario selection

A comparison must select execution scenarios explicitly, independently of hypothesis mappings:

```yaml
execution:
  profile: smoke
  scenarios:
    include: [scenario-a, scenario-b]
```

or:

```yaml
execution:
  profile: smoke
  scenarios:
    all: true
```

Exactly one form is required. Unknown and duplicate IDs fail validation. `all` expands to concrete IDs in `resolved-plan.json`. A hypothesis referencing an unselected scenario produces a warning; selected regression scenarios need not belong to a hypothesis.

Invocation mode is metadata plus linting. The runner never rewrites the authored prompt. It uses invocation metadata to lint likely prompt/run-arm mismatches, organize reports, and later analyze activation evidence.

### Skill arms

- Control explicitly disables the evaluated skill.
- Baseline must resolve from a committed Git ref.
- Candidate may resolve from a committed ref or an explicit local snapshot.
- A local candidate path is declared as `arms.candidate.snapshot.path` and resolved relative to the comparison file.
- Before approval, the controller freezes the local candidate, rejects escaping symlinks, records file hashes and a content digest, and records available Git HEAD/dirty provenance. Active runs never consult the source directory again.

### Profiles and targets

- Targets require an exact provider/model identifier and an explicit thinking level; neither inherits from the initiating Pi session.
- A selected profile containing an unavailable harness, model, or thinking level fails validation.
- Profiles may set `maxConcurrency`; omission resolves to `1`.
- Profiles may set an optional evaluation `maxCost`. Reaching it stops new dispatch while active cells finish, so observed cost may overshoot.
- Optional supervisor model and thinking configuration live in the profile, independent of evaluated targets. Supervisor configuration is used beginning in milestone 2; a milestone-1-only runner must not silently ignore it.

### Fixtures and setup

Milestone 1 supports:

- Local fixture directories resolved relative to the suite and frozen by content hash.
- Git fixtures from a local repository or remote URL at a required ref resolved to an immutable commit.

Submodules and Git LFS are unsupported initially. A fixture may declare exactly one setup form:

```yaml
setup:
  command: npm ci
  network: true
```

or:

```yaml
setup:
  script: setup/prepare-fixture.sh
  network: false
```

A script path resolves relative to `suite.yaml` and executes with the fixture as its working directory. Setup runs once per scenario, before any evaluated agent. The prepared fixture is hashed, given a clean synthetic Git grading checkpoint, and frozen as the identical source for every arm/model/repetition cell. Setup inherits the host environment and must therefore be treated as trusted host code. Setup network defaults to disabled and requires `network: true`; evaluated-agent network permissions remain separate. Setup failure stops the scenario before model spending.

## Execution policy

### Pi arm isolation

Pi cells run noninteractively with session persistence, ambient skills, extension discovery, prompt templates, and automatic context discovery disabled. Control loads no explicit skill; baseline and candidate load only their frozen explicit skill path.

Fixture-owned `AGENTS.md` and `CLAUDE.md` files are always included. The controller discovers only context files inside the frozen fixture, compiles them in normal hierarchical order with source markers, and injects them explicitly. Host and parent-directory context is excluded.

Suites define default tool allowlists and scenarios may replace them. Unsupported tool names fail validation. A dedicated evaluation guard applies path checks, sanitized agent shell environments, known dangerous-command and push blocking, and platform network restrictions where available. If strong platform isolation is unavailable, execution continues best-effort after an approval warning; every cell and report records the achieved isolation level.

### Scheduling and interruption

The matrix is scheduled as strict paired comparison blocks. A block contains all selected arms for one scenario, target, and repetition. Block order and arm rotation are deterministic from a recorded seed. One block completes before the next begins, and profile concurrency applies within the active block. This keeps completed evidence balanced and avoids consistently running candidate after baseline.

Pause is checkpoint-safe:

```text
running -> pause_requested -> paused -> running
```

A pause request prevents new cells from starting while active cells finish. Remaining cells in the current block wait for resume. Cancel is immediate and irreversible. Deterministic failures do not stop the matrix; Pi records and surfaces them, while the user may pause or cancel.

There are no automatic cell retries. Provider, harness, or infrastructure errors remain auditable errored observations. Statistical repetition must be authored explicitly rather than introduced by retry behavior.

### Grading and acceptance

Before running grader commands, the controller freezes the post-agent workspace diff and trace so grading side effects cannot change the evidence under evaluation. Milestone 1 supports the focused deterministic checks listed earlier in this document.

Acceptance supports:

- Required-cell completeness.
- All candidate critical checks passing.
- No paired critical baseline-to-candidate regression.
- Candidate pass-rate threshold.
- Candidate-versus-baseline pass-rate delta.
- Candidate-versus-control skill lift.
- Observed median cost and elapsed-time limits or deltas.

Gated acceptance is a unified list of identified, typed rules rather than separate string and threshold sections. For example:

```yaml
acceptance:
  mode: gated
  rules:
    - id: candidate-critical-checks
      type: all-candidate-critical-checks-pass

    - id: no-critical-regressions
      type: no-critical-regressions

    - id: baseline-delta-by-scenario
      type: pass-rate-delta
      compareTo: baseline
      scope: eachScenario
      minimum: 0

    - id: skill-lift
      type: pass-rate-delta
      compareTo: control
      scope: overall
      minimum: 0.05

    - id: cost-regression
      type: median-cost-increase
      compareTo: baseline
      scope: eachTarget
      maximum: 0.25
```

Rule IDs are stable and unique. Numeric rule types require an explicit scope; non-numeric rules reject numeric fields. Every scoped bucket gets its own gate result, and missing required buckets produce `not_evaluated` unless another bucket already proves the rule failed. Exploratory comparisons declare `mode: exploratory` and reject `rules`.

Unsupported acceptance rules fail validation. The controller continues after deterministic failures. A supervisor cannot change any check or acceptance result.

## Durable state and recovery

### Storage and single-writer model

Private state lives under `~/.pi/agent/skill-evals/`. `events.jsonl` is authoritative; `state.json` is an atomically replaced projection for fast readers. Only the lock-owning detached controller or finalizer writes lifecycle state. Pi commands submit atomic, idempotent requests through `control/`.

A common event envelope includes schema version, monotonically increasing sequence, event ID, run ID, timestamp, type, and typed data. The event ledger stores lifecycle and grading facts only. Prompt text, model output, and tool-call details remain in redacted per-cell traces referenced by artifact path and digest.

`controller.json` carries PID, worker version, and heartbeat separately so heartbeats do not flood the event ledger. A global lock enforces one active top-level run. Cancel takes precedence over pause or resume.

### State dimensions

State separates:

- **Lifecycle:** preparation, running, pause requested, paused, cancelling, completed, cancelled, or interrupted.
- **Controller health:** derived live, stale, or missing state from PID and heartbeat.
- **Evaluation verdict:** pending, pass, fail, incomplete, or informational.

Cells separately track preparation, execution, grading, and pass/fail/error/not-run outcomes. Lifecycle events include run controls, fixture preparation, block transitions, cell transitions, check outcomes, budget exhaustion, and artifact recording.

### Interrupted workers

Every Pi startup scans the global registry. A live run produces one non-blocking notification; the session receives no continuing progress updates unless it explicitly opens the monitor.

A stale or dead controller is not automatically resumed. Pi offers finalization as an infrastructure interruption. The finalizer acquires the global lock, terminates surviving harness processes, marks active cells errored and pending cells not run, preserves completed evidence, emits a partial report, and sets lifecycle to interrupted. Verdict is incomplete unless completed evidence already proves an acceptance failure, in which case verdict is fail with incomplete evidence.

## Pi command and monitor interface

The command uses a hybrid direct-and-guided interface. With no arguments, `/skill-eval` opens an action picker; direct forms remain available:

```text
/skill-eval validate <comparison>
/skill-eval run <comparison> [--profile smoke] [-b]
/skill-eval status [run-id]
/skill-eval monitor [run-id]
/skill-eval pause [run-id]
/skill-eval resume [run-id]
/skill-eval cancel [run-id]
/skill-eval report [run-id]
/skill-eval delete <run-id>
```

A successful `run` opens the model-free live monitor immediately in TUI mode; `-b` leaves the detached run in the background. `monitor` also reopens that dashboard later. Other Pi sessions remain quiet after their one-time startup notification. Closing the dashboard restores Pi's normal editor and never changes the run.

### Monitor dashboard

The monitor is a non-overlay custom Pi component with five top-level views:

1. **Overview:** lifecycle and verdict, progress bar, completed blocks and cells, active paired block, elapsed time, evaluation and supervisor cost, controller heartbeat, isolation level, recent failures, the latest supervisor recommendation, and a selectable live summary for every active evaluated agent.
2. **Processes:** local controller and evaluated-cell process tree with PID, parent PID, CPU, RSS, elapsed time, and command.
3. **Matrix:** one row per comparison block with adjacent control, baseline, and candidate states; drill-down into block and cell evidence.
4. **Findings:** deterministic critical regressions and acceptance-rule progress.
5. **Events:** recent lifecycle events without prompt, assistant-text, transcript, or tool-argument bodies.

The default Overview exposes run metadata plus each active agent’s latest assistant or tool activity from its persisted redacted trace. Selecting a running agent opens its real stdout/stderr received after the monitor connects, over an ephemeral local socket; it is held in monitor memory only and is never written to the run bundle. Completed cells remain drillable through their persisted redacted timeline. Matrix cells remain drillable after completion.

Keyboard behavior is:

```text
tab / shift+tab    Change top-level view
up / down          Select a row
enter              Open a selected active agent, block, cell, finding, or rule
escape             Move back; close from the overview
q                  Close the monitor from anywhere
p                  Pause a running run or resume a paused run
c                  Begin cancellation confirmation
r                  Force an immediate state refresh
?                  Show help
```

Pause and resume are submitted immediately because they are reversible. Cancellation enters an inline `y`/`n` confirmation state rather than opening a nested Pi dialog. `Ctrl+C` closes the monitor and does not cancel the evaluation. Pending controls remain visible until the controller acknowledges or rejects their request IDs.

The component polls atomic state and heartbeat files about once per second, incrementally reads lifecycle events only when the event sequence advances, and re-renders only when displayed state or elapsed time changes. Polling stops for terminal runs, and all timers are disposed when the component closes. A stale controller is displayed prominently and directs the user to interruption finalization.

Rendering is responsive: wide terminals show complete tables, medium terminals shorten model and scenario labels, and narrow terminals use stacked rows. Matrix, event, finding, and trace views scroll within bounded windows. Selection remains stable across refreshes where possible, every rendered line is ANSI-aware width-limited, and theme-dependent content is rebuilt after theme changes.

Decision-relevant supervisor findings appear as banners with severity, finite recommendation, summary, and evidence links. Dismissing a banner affects only the current dashboard process; it does not alter persisted findings or reports. Completed runs remain inspectable through the same dashboard without active polling.

Runs and their compact audit bundles remain until explicit confirmed deletion. Active runs cannot be deleted.

## Advisory supervisor

The supervisor is checkpoint-driven, never a continuous process monitor.

### Checkpoints and authority

It runs at:

1. **Preflight:** after refs and the local candidate are frozen, before final approval.
2. **Anomaly:** only for deterministic, deduplicated critical triggers.
3. **Final:** blind comparison followed by unblinded release synthesis.

Critical anomaly triggers are a paired critical regression, a repeated candidate execution anomaly, a sandbox/permission violation, or acceptance becoming mathematically impossible with remaining cells. Equivalent anomalies are coalesced by scenario, check, and category.

Supervisor failures or invalid output are recorded but never stop deterministic execution or alter its verdict. Supervisor spending is tracked separately but is uncapped and does not consume the evaluation-cell budget.

The supervisor may recommend only a finite advisory action such as `continue`, `human_review`, `consider_pause`, or `consider_cancel`. Preflight uses `proceed`, `proceed_with_review`, or `revise_before_run`; final synthesis uses `candidate_supported`, `candidate_not_supported`, `inconclusive`, or `human_review_required`. The controller never executes these recommendations automatically.

### Evidence access and output

Each checkpoint receives a generated, redacted evidence bundle with masked summaries, deterministic outcomes, normalized usage/timing, relevant trace excerpts, diffs, checked artifacts, and a hash manifest. The supervisor has only path-confined read access to that bundle and a terminating structured-output tool. It has no bash, write, edit, broad run-directory, repository, or controller access, and no ambient skills, extensions, prompts, or context.

Findings must use a versioned schema with stage, finite recommendation, severity, summary, claims, evidence references, confidence, and limitations. Claims without valid evidence references make the advisory output invalid.

### Blinding and persistence

Preflight is a one-shot unblinded advisor because it reviews methodology and release hypotheses. Anomaly reviews and the first final comparison use stable masked arm IDs in one persistent blind supervisor session. The controller resumes that private Pi session only at checkpoints; it does not keep an idle process alive. The blind session never receives the arm mapping.

After the blind final finding is persisted, a separate fresh unblinded synthesizer receives the mapping, deterministic results, hypotheses, and blind findings. It cannot alter the blind record or deterministic verdict. At finalization, the controller exports a redacted supervisor transcript and structured findings, then removes the native resumable Pi session.

## Implementation layout

The implemented milestone keeps the Pi extension thin and consolidates shared responsibilities into focused modules:

```text
extensions/evals/skill-eval/
├── index.ts                    # registration, startup scan, picker, direct commands
├── dashboard.ts                # model-free live monitor
└── runtime/eval-guard.ts       # loaded only in evaluated Pi cells

src/shared/skill-eval/
├── domain.ts                   # authored, resolved, event, state, and result contracts
├── planning.ts                 # strict YAML loading and validation
├── resolver.ts                 # freezing, capability validation, matrix expansion
├── filesystem.ts              # Git/local materialization, manifests, archives, commands
├── storage.ts                 # registry, lock, events, projection, controls, finalizer
├── controller.ts              # preparation, paired scheduling, lifecycle, cleanup
├── worker-entry.ts             # detached tsx process entry
├── harness.ts                  # isolated Pi adapter and redacted JSON trace capture
├── grading.ts                  # deterministic checks and typed acceptance rules
├── reporting.ts                # Markdown and JSON reports
└── security.ts                 # credential and path redaction

tests/skill-eval.test.ts        # strict-plan and fake-Pi end-to-end coverage
```

Only `extensions/evals/skill-eval/index.ts` is registered in `package.json`; the evaluation guard is loaded explicitly into evaluated child Pi processes and never appears in normal sessions. The controller worker runs through `tsx` as a runtime dependency, so the source package needs no committed build output.

State projection is a pure reducer from prior state plus typed event, with serialized event writes under cell concurrency. The Pi adapter executes and normalizes cells but does not grade, schedule, report, or own lifecycle.

## Implementation sequence

Implementation proceeds in reviewable slices:

1. **Contracts and validation — implemented:** strict authored YAML, resolved plan, event, state, cell result, acceptance, artifact contracts, exact matrix, and approval preview.
2. **Milestone 1 durable controller — implemented in source:** Pi-only execution with local candidate freezing, local and Git fixtures, once-per-scenario setup, three arms, strict paired blocks, background durability, state/event persistence, status, monitor, pause/resume/cancel/delete, focused deterministic grading, acceptance deltas, Markdown/JSON, and compact redacted artifacts. A real-provider smoke run remains the release checkpoint.
3. **Milestone 2 advisory supervisor:** add preflight, critical-anomaly, blind persistent review, final unblinded synthesis, structured findings, dashboard integration, and redacted supervisor transcripts.
4. **Adapter expansion:** add Codex and Claude Code adapters, additional explicit models, and normalized capability/usage reporting.
5. **Reporting and hardening:** add HTML/export, richer check types, historical trends, broader real-repository suites, stronger platform isolation where practical, and failure-path coverage.

Checkpoint implementation after each slice. The supervisor and additional harnesses must not be added until deterministic Pi execution, isolation, grading, and durable evidence are reliable.

## Milestone 1 boundary

The first executable milestone includes:

- Pi as the only user-facing interface and implemented harness adapter.
- One globally active detached run that survives Pi exit.
- Explicit Pi model and thinking configuration.
- No-skill control, committed baseline, and local or committed frozen candidate.
- Explicit scenario selection and strict paired block ordering.
- Local and Git fixtures with trusted once-per-scenario setup.
- Background status plus a dedicated live monitor dashboard.
- Checkpoint-safe pause/resume and immediate cancel.
- No automatic retries and continued collection after check failure.
- Command, file, diff, and trace deterministic checks with required severity.
- Deterministic completeness, critical-regression, pass-rate, cost, and time gates.
- Event-sourced private state, startup notification, stale-run finalization, and manual deletion.
- Markdown/JSON reports and compact redacted evidence.

The advisory supervisor, Codex and Claude Code adapters, HTML/export, richer grading, and historical analysis follow in later milestones.

## Remaining open decisions

The high-level architecture, user-facing behavior, evaluation semantics, lifecycle, and milestone boundaries are settled. The remaining items below are delegated implementation details rather than unresolved product decisions; implementation may choose the safest practical approach while preserving the requirements above:

1. Fine-grained versioned YAML and JSON payloads for check expectations, event data, artifacts, and structured supervisor findings; the high-level strictness, defaults, override boundaries, and acceptance shape are settled.
2. Concrete command argument grammar, picker fields, and approval-screen layout; the monitor dashboard's views, controls, polling, and privacy behavior are settled.
3. Run, block, cell, event, control-request, and artifact-manifest payload details.
4. Exact Pi adapter system prompt, tool guard implementation, trace normalization, and platform isolation capability detection.
5. Redaction rules, artifact size limits, and which generated/untracked files enter the compact bundle.
6. Git authentication, cache, submodule/LFS rejection, and fixture license/provenance details.
7. Exact supervisor checkpoint bundle and structured-output schemas, prompt versions, session invocation, and malformed-output handling.
8. Skill-activation evidence and richer deterministic checks for later milestones.
9. Whether candidate-versus-control lift is informational or a required gate in each authored comparison; the runner will not invent this policy.

## Research incorporated

The design incorporates lessons from:

- [StackHawk: An Eval Harness for Agent Skills](https://www.stackhawk.com/blog/eval-harness-agent-skills/): explicit hypotheses, real repositories, hidden answer keys, controlled runs, and skill-blind judging.
- [DeepEval: What Is an Eval Harness?](https://deepeval.com/blog/what-is-an-eval-harness): offline evaluation as datasets, traces, and metrics; distinction between evals and runtime guardrails.
- [OpenAI: Testing Agent Skills Systematically with Evals](https://developers.openai.com/blog/eval-skills): explicit, implicit, contextual, and negative activation; structured event capture; small explainable graders.
- [Tessl: Anthropic Brings Evals to Skill Creator](https://tessl.io/blog/anthropic-brings-evals-to-skill-creator-heres-why-thats-a-big-deal): no-skill controls and separation of executor, grader, comparator, and analyzer responsibilities.
