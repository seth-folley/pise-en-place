# Simplified skill evaluation: implementation plan

## Status

The first V1 implementation is complete: schema validation, sequential execution, monitoring, evidence capture, workspace cleanup, and artifact-only Markdown/HTML reporting are implemented. A separate reviewer skill, optional authored rubric sidecar, validated structured review format, and deterministic shared review HTML template are also implemented. Synthetic tests cover configuration, workspace safety, Git evidence, dialog policy, partial harness-error evidence, report regeneration, rubric retention, and review rendering. A live provider run and interactive monitor QA remain manual release checks.

This document remains the durable product and implementation contract. Update its decision log and affected sections whenever the design changes.

## Purpose

Run one configured Pi agent against one or more prompt variants, then make its behavior easy to observe and review.

The evaluator must provide:

- an agent-only diff for each variant;
- explicit agent and harness configuration;
- a live view of the conversation, tool calls, and process;
- deterministic tool-call and approach evidence;
- cost, token, and timing metrics;
- consistent Markdown and HTML reports.

The evaluator should remain a small foreground runner, not a fixture-management or automated-grading system.

## Locked decisions

- Configuration is YAML.
- There is one agent configuration per evaluation.
- Each variant has its own inline prompt.
- Replacements are global to the evaluation and apply before all variants.
- A replacement copies one complete source file over a project-relative target.
- Replacement sources resolve relative to the eval YAML.
- Replacement targets resolve relative to the prepared workspace and may be new files.
- Variants within a run execute sequentially; only one variant session runs at a time.
- Independently invoked runs may coexist in separate Pi processes and isolated run directories; there is no global lock or queue in V1.
- The source workspace is never modified.
- Evaluated workspaces use a fresh disposable Git baseline and do not preserve source history.
- Pi discovers the resources it would in a normal session, including extensions, skills, prompts, settings, and context files.
- A variant prompt is one ordinary user message to Pi. It never replaces, appends to, or otherwise becomes the system prompt, `AGENTS.md`, or another context resource.
- Semantic outcomes are assigned only by the separate `skill-eval-reviewer` workflow. The execution harness records execution status, limits, and policy findings only.
- An optional same-basename review-rubric sidecar records authored objectives and observable expectations. It is validated and retained but never submitted to the evaluated agent.
- Semantic review uses ordinal, evidence-cited outcomes without a numeric score and defaults to retained run artifacts only.
- A timeout, blocked interaction, cancellation, harness error, or tool-policy finding stops the run before another variant starts and produces a partial report.
- Each variant uses the eval-level timeout, defaulting to 300 active-execution seconds.
- Completed disposable workspaces are deleted after evidence capture.
- Retained run artifacts remain indefinitely until manually removed.
- Runs are foreground-only and always open a monitor.
- The monitor is full-screen, stays open after completion, and shows a detailed per-variant progress view.
- Child extensions cannot modify the parent session or leave persistent parent UI state.
- Child-dialog behavior is globally configured as interactive or safe auto-reject; interactive is the default. An uncancellable custom dialog in auto-reject mode stops the variant as `interaction_blocked`.
- Interactive child-dialog wait time is recorded but paused out of the per-variant execution timeout.
- Reports are generated as both Markdown and HTML using summaries and relative links to complete evidence rather than embedding transcripts, tool results, or patches.
- Retained evidence must be sufficient to regenerate reports without access to the disposable workspace or in-memory run state.
- Every variant retains its complete native Pi session plus a deterministic human-readable transcript.
- The execution harness invokes no judge or grading model. Semantic review is a separate, explicitly requested skill workflow and produces no numeric score.

## Command surface

```text
/skill-eval validate <eval.yaml>
/skill-eval run <eval.yaml>
/skill-eval review <run-id|path|latest>
```

`validate` remains inexpensive and does not resolve models, inspect Git, or mutate files.

`run` reuses validation and then starts immediately. Invoking `run` is authorization to spend model tokens; there is no second approval dialog.

Because every run must have a monitor, `run` initially requires interactive TUI mode. It should report a clear error in print or JSON mode rather than silently running without visibility.

`review` requires an explicit selector, rejects runs whose retained status is still `preparing` or `running`, and dispatches the reviewer skill in the current idle session. It does not duplicate semantic-review logic or create a second review monitor.

## YAML schema

```yaml
version: 1
name: package-architecture

# Absolute, or relative to this YAML file.
workspace: ../../

agent:
  harness: pi
  model: anthropic/claude-sonnet-4-5
  thinking: medium
  tools:
    - read
    - bash
    - edit
    - write

# Optional. The default is 300 seconds per variant.
limits:
  timeoutSeconds: 300

# Optional: interactive (default) or auto-reject.
dialogs: interactive

# Optional. Applied to the common disposable setup before variant baselines.
replacements:
  # Relative to this YAML file and must exist.
  - source: setup/Package.swift

    # Relative to the prepared project. It and its parents may be absent.
    target: Packages/Feature/Package.swift

# Required and non-empty. Every variant has one inline prompt.
variants:
  reject-production-dependency:
    prompt: |
      Determine whether this dependency is permitted. Make the change if it is
      appropriate; otherwise leave the project unchanged and explain why.

  recommend-shared-package:
    prompt: |
      This implementation is needed by multiple features. Determine where it
      should live and make the appropriate project changes.
```

### Schema defaults and constraints

- `version` must be `1`.
- `agent.harness` must be `pi` in the first implementation.
- `agent.thinking` is optional.
- `agent.tools` is optional. When omitted, Pi's normal enabled-tool defaults apply and there is no narrower evaluator tool policy.
- `limits` is optional. `limits.timeoutSeconds` is a positive integer and defaults to `300`; the setting applies independently to every variant.
- Cost enforcement is deferred. V1 records cost but has no `maxCostUsd` field.
- `dialogs` is optional and defaults to `interactive`. The other V1 value is `auto-reject`.
- `replacements` is optional.
- At least one variant is required.
- Variant names and prompts must not be blank.
- Unknown fields are rejected.
- Skills are intentionally not configurable in YAML; Pi discovers them from the prepared workspace and normal global resources.
- Variant prompts are submitted as ordinary user turns through Pi's normal input/session path. Both the configured YAML prompt and the user message persisted by Pi are retained as evidence.

## Validation contract

Validation does only the work required to parse the configuration and locate its inputs:

- read and parse YAML;
- validate the strict schema;
- confirm that the workspace directory exists;
- confirm that every replacement source is an existing file;
- discover and strictly validate an optional same-basename `<eval>.review.yaml` or `<eval>.review.yml` sidecar, including matching variant IDs;
- enforce that replacement sources are YAML-relative paths;
- enforce that replacement targets are workspace-relative and lexically contained by the workspace.

Validation intentionally does not inspect:

- replacement target existence or contents;
- target parent existence;
- Git state or history;
- model or provider availability;
- tool availability;
- symlinks across the project;
- submodules or Git LFS;
- build products or generated files;
- project correctness.

Target-write containment checks performed later during execution are mutation safety, not fixture validation.

## Run lifecycle

### 1. Validate

Call the same loader used by `/skill-eval validate`. Fail before creating a model session if configuration or source files are invalid.

### 2. Create private run storage

Create a unique directory under:

```text
~/.pi/agent/skill-evals/<run-id>/
```

Use the run-ID format `<UTC-basic-timestamp>-<sanitized-eval-name>-<8-hex-random>`, for example `20260821T204425Z-package-architecture-af02bb9b`.

Use private permissions for the run directory and artifacts because raw prompts, tool output, source excerpts, and paths may be sensitive.

Immediately copy the original YAML into the run directory and write a resolved configuration snapshot. When the optional sibling rubric exists, retain it as `review-rubric.yaml` and index it without injecting it into the child prompt or context. Initialize versioned `run.json` with operational status, variant status/completeness, and relative artifact paths. Once a run directory exists, any later failure must print that path.

### 3. Materialize a common prepared workspace

- Recursively copy the supplied workspace with Node's `fs.cp`, using `COPYFILE_FICLONE`, `dereference: false`, `verbatimSymlinks: true`, and timestamp preservation.
- This requests copy-on-write clones where the filesystem supports them and falls back to ordinary file copies otherwise.
- Preserve generated files, ignored files, modes, timestamps, and symlinks without traversing them.
- Never run setup commands.
- Never mutate the source workspace.

This operation should be abort-aware where the platform APIs allow it and should stop between files/phases when cancellation has been requested.

### 4. Apply global replacements

For each replacement, in YAML order:

1. Resolve the source from the YAML directory.
2. Resolve the target inside the disposable prepared workspace.
3. Verify the target's nearest existing parent resolves inside the disposable workspace before writing. This narrowly protects evaluator-owned writes from parent symlinks without scanning or policing the rest of the project.
4. Create missing parent directories.
5. Remove an existing target path itself so a target symlink is replaced rather than followed.
6. Copy the entire source file and its executable mode to the target.
7. Record source path, target path, size, mode, and content digest.

A replacement failure aborts before any model call.

### 5. Establish the disposable Git baseline

The evaluator deliberately does not preserve source Git history:

1. Remove copied root `.git` metadata from the disposable workspace. This prevents a copied worktree `.git` pointer from mutating source repository metadata.
2. Initialize a fresh repository.
3. Configure an evaluator-local commit identity.
4. Stage the current Git-visible state using ordinary ignore rules.
5. Commit it as the evaluation baseline.
6. Record the baseline commit SHA.

Ignored/generated files remain present for the agent but are not part of the diff contract.

### 6. Run variants sequentially

For each variant, in YAML order:

1. Clone the prepared baseline into an independent disposable variant workspace.
2. Mark the variant as `preparing`, then `running`.
3. Create one fresh Pi SDK session rooted at the variant workspace, with its native `SessionManager` persisted directly under the variant evidence directory.
4. Resolve the configured model and authentication at runtime.
5. Apply configured model, thinking level, and tool allowlist.
6. Discover normal Pi resources from the variant workspace and global agent directory.
7. Bind child-extension dialogs to the monitor UI.
8. Send the variant's inline prompt as one ordinary user message, never as system/context instructions.
9. Start the variant's configured active-execution timeout when Pi accepts the prompt. It includes model calls, tools, retries, and compaction, but pauses while the evaluator waits for a human answer to an interactive child dialog.
10. Stream normalized session events to both the monitor and artifact recorder.
11. Wait for the session to settle, including normal retries or compaction, unless cancelled or timed out.
12. Block any attempted tool call outside an explicit `agent.tools` allowlist, return a denied tool result so the current session can continue, and record a tool-policy finding. Do not expose disallowed tools intentionally.
13. Capture final response, metrics, Git-visible changes, and resource metadata.
14. Dispose the SDK session and remove its workspace.

The same model runtime may be reused across variants, but every variant gets a fresh session, context, resource discovery result, and workspace. A completed session with a tool-policy finding retains its later response for analysis but prevents the next variant from starting. Independently invoked runs are not serialized globally.

### 7. Capture agent-only changes

The baseline commit SHA, not the post-agent `HEAD`, defines the start state. This preserves changes even if the agent creates commits.

After the session finishes:

1. Capture pre-collection `git status --short --untracked-files=all`.
2. Stage final Git-visible changes in the disposable repository for evidence collection.
3. Generate a binary-capable patch from the baseline SHA to the staged final tree.
4. Generate changed-file and insertion/deletion statistics.

The runner stages only in the disposable workspace. It does not alter the source.

Known limitation: changes to ignored files are intentionally omitted from the patch and changed-file metrics, even though ignored files remain available to the agent.

### 8. Generate reports and clean up

After completion, timeout, policy stop, harness error, or cancellation:

- finalize per-variant metrics;
- write Markdown and HTML reports from retained evidence;
- record final run status;
- remove disposable workspaces;
- keep the monitor open in its final state;
- after the user closes it, print the report and run-directory paths in the parent Pi session.

## Pi harness behavior

Use the Pi SDK in the current process rather than spawning a nested interactive Pi terminal.

Core SDK pieces:

- `createAgentSession()`;
- `ModelRuntime` and CLI-compatible model resolution;
- a fresh persisted `SessionManager` whose session directory is inside the variant's retained evidence directory;
- `DefaultResourceLoader` and normal `SettingsManager` discovery;
- an explicit `cwd` for each variant;
- configured model, thinking level, and tools.

### Resource discovery

Load resources as a normal Pi session would:

- global and project extensions;
- extension-provided tools;
- global and project skills;
- `AGENTS.md` and other context files;
- global and project settings;
- prompt templates and themes.

The configured model, thinking level, and explicit tools override discovered defaults. When `agent.tools` is omitted, normal Pi tool defaults apply. Retry, auto-compaction, and other session behavior use the normally discovered Pi settings; V1 adds no evaluator-specific controls for them.

Record the resolved resource set for trust and reproducibility:

- active model/provider and thinking level;
- active tools and their source paths;
- loaded extensions and load diagnostics;
- loaded skills and paths;
- loaded context files and paths;
- relevant settings source paths and resolved retry/compaction behavior;
- Pi/package, Node, OS/architecture, and Git versions.

### Child-extension UI

Child-extension UI requests should not hang, modify the parent session, or leave persistent parent UI state. Do not pass the parent's full UI context directly into child extensions. Bind a scoped evaluator-owned proxy instead.

In `dialogs: interactive` mode:

- present standard `confirm`, `select`, `input`, and `editor` requests over the monitor;
- present supported custom dialogs within the same scoped overlay mechanism;
- temporarily yield monitor focus while a child dialog is active;
- restore monitor focus after it closes;
- record the request, response, and elapsed wait as evidence.

In `dialogs: auto-reject` mode:

- answer confirmation requests with `false`;
- cancel selection, input, and editor requests with `undefined` or the closest API-supported cancelled result;
- never invent a result for a generic custom dialog whose type has no safe cancellation value; record it, abort the active session as `interaction_blocked`, and stop later variants;
- never auto-accept a safety confirmation;
- record every request and automatic response or interaction block as evidence.

In both modes:

- show or record notifications without appending them to the parent conversation;
- convert child status changes into monitor/evidence events when practical;
- isolate or suppress child widgets, headers, footers, editor mutations, and other persistent UI changes;
- clean up all scoped UI state when the child session is disposed.

This allows normal interactive behavior when requested and a deterministic safe unattended mode without allowing child sessions to mutate the parent session.

## Normalized run event stream

The runner, monitor, artifact recorder, metrics, and reports must share one normalized event stream. The monitor must not maintain a second interpretation of raw SDK events.

Representative event kinds:

```text
run_started
workspace_copy_started
workspace_copy_completed
replacement_applied
baseline_created
variant_preparing
variant_started
session_resource_loaded
message_started
message_updated
message_completed
tool_started
tool_updated
tool_completed
retry_started
retry_completed
compaction_started
compaction_completed
variant_completed
variant_timed_out
variant_cancelled
variant_harness_error
variant_interaction_blocked
tool_policy_violation
diff_captured
report_started
report_completed
run_completed
run_stopped
run_harness_error
run_cancelled
```

Every event should contain:

- timestamp;
- run ID;
- variant ID when applicable;
- event-specific structured data.

Raw SDK messages and tool results are retained alongside normalized events for native rendering and auditability.

## Evidence contract

Evidence is the source of truth; reports are derived views. Report generation must run as a separate pass that reads only the retained run directory. It must not depend on live monitor components, disposable workspaces, SDK objects, or other in-memory runner state.

Each retained file has one of three roles:

- **Canonical evidence:** versioned `run.json`, original eval YAML, optional authored review rubric, resolved configuration, replacement manifest, native Pi session, normalized event stream, effective system prompt, Git status, and Git patch.
- **Derived analysis:** tool-call index, metrics, human-readable transcript, changed-file summaries, and resource summaries.
- **Presentation:** Markdown and HTML reports.

Versioned `run.json` indexes the run and variants, records operational status, current and failed lifecycle phases, artifact completeness, and relative canonical and derived artifact paths. A separate per-file artifact manifest is unnecessary in V1. Stopped runs also retain an indexed `failure.json` with structured error chains, subprocess diagnostics, the last lifecycle event, affected variant evidence, and deterministic phase-specific diagnostic hints.

A run is valid evidence even when partial. `run.json` must represent expected evidence as not started, partial, complete, or unavailable instead of silently omitting it.

### Complete agent session transcript

For every started variant, retain the native append-only Pi session JSONL produced by `SessionManager`. It is the canonical conversation record and should remain compatible with Pi's session parser. It includes, when present:

- the exact user prompt delivered to the session;
- assistant thinking and text content;
- tool calls, arguments, and complete tool results;
- usage, cost, stop reason, model, and provider metadata carried by assistant messages;
- extension-injected custom messages, including messages hidden from normal display;
- compaction summaries and context-tree metadata;
- model or thinking-level changes;
- session and extension custom entries.

Also generate `transcript.md` deterministically from the native session plus lifecycle events. It is for human review and must preserve message order while clearly labeling:

- user, assistant, thinking, tool call, and tool result sections;
- hidden/custom messages;
- retry, compaction, cancellation, and error events;
- omitted binary/image payload metadata;
- binary/image payload metadata that cannot be represented directly in Markdown.

The native session JSONL and textual `transcript.md` must not be truncated. Only the summary reports omit large evidence bodies and link to their complete artifacts.

Save the effective initial system prompt separately because it is not ordinarily a message entry in Pi's session file. If an extension changes the effective system prompt between turns, retain ordered prompt snapshots or changed snapshots with turn number, timestamp, and digest. Combined with `resources.json`, this makes the model-visible instructions analyzable without relying on the deleted workspace.

Streaming deltas and harness lifecycle timing belong in `events.jsonl`; finalized conversation content belongs in the native Pi session. Together they support both replay-style analysis and exact timing analysis without treating a lossy rendered transcript as canonical.

## Full-screen run monitor

Every run opens a full-screen focused overlay. There is no background mode or separate monitor command in the first implementation.

### Rendering

Use Pi's exported native interactive components:

- `UserMessageComponent` for each variant prompt;
- `AssistantMessageComponent` for streaming and finalized assistant messages;
- `ToolExecutionComponent` for tool calls, partial results, final results, diffs, images, and custom renderers.

Pass child registered tool definitions to `ToolExecutionComponent` so extension tools retain their normal renderer when available. Use the native fallback renderer otherwise.

Do not launch another TUI process that competes for terminal input. The monitor renders the child SDK session inside the parent TUI.

### Wide layout

```text
┌ Variants ───────────────┬ Active transcript ──────────────────────┐
│ ✓ first                 │ prompt                                  │
│   01:12   $0.084        │                                         │
│ ● second                │ assistant/tool stream...                │
│   00:34   $0.021        │                                         │
│ ○ third                 │                                         │
├────────────────────────┴──────────────────────────────────────────┤
│ 1/3 finished · total 01:46 · current $0.021 · total $0.105        │
│ PgUp/PgDn scroll · End follow · Ctrl+O tools · Esc cancel         │
└───────────────────────────────────────────────────────────────────┘
```

### Narrow layout

Move the detailed variant status table above the transcript. Keep the current variant visible and truncate long names safely. The table is informational in V1; completed variants cannot be selected inside the monitor. The transcript always shows the active variant, or the final attempted variant after the run settles.

### Variant statuses

- `○` pending
- `◌` preparing
- `●` running
- `✓` completed execution (not a semantic pass)
- `!` completed with a policy finding
- `⌛` timed out
- `?` interaction blocked
- `✗` harness error
- `⊘` cancelled

### Input behavior

Respect the injected keybinding manager rather than hardcoding keys.

- `app.tools.expand` (Ctrl+O by default): expand/collapse all tool outputs.
- Fullscreen transcript page-up/page-down bindings: scroll the transcript.
- Fullscreen transcript bottom binding: return to the bottom and resume auto-follow.
- Escape while running: abort the active session and entire evaluation.
- Enter or Escape after completion, timeout, policy stop, interaction block, harness error, or cancellation: close the monitor.

The transcript automatically follows new output until the user scrolls upward. Tool execution and streaming assistant messages update in place.

The monitor is read-only in the first implementation. It does not support steering, follow-up prompts, or editing the variant prompt.

### Completion behavior

The monitor remains open after the run finishes. It replaces the running footer with final status, metrics, and instructions to close. Closing returns to the parent Pi conversation and prints artifact paths.

## Metrics

### Per variant

- execution status: completed, timed out, interaction blocked, cancelled, or harness error;
- policy findings, including attempted disallowed tools;
- elapsed wall-clock time, from accepted prompt to settled session;
- active execution time used against `limits.timeoutSeconds`;
- interactive child-dialog wait time excluded from the execution timeout;
- input tokens;
- output tokens;
- cache-read tokens;
- cache-write tokens;
- total finalized cost, or the literal value `unavailable` when the provider does not supply it;
- tool-call count;
- tool-failure count;
- changed-file count;
- insertions and deletions.

### Run totals

- completed, policy-finding, timed-out, interaction-blocked, harness-error, cancelled, and pending variant counts;
- total wall time, including workspace preparation and report generation;
- current variant elapsed time and finalized spend;
- total finalized spend across completed and active variants;
- aggregate token and tool counts.

Provider usage is authoritative only when a response finalizes. The monitor may update elapsed time continuously, but cost and token totals update on finalized assistant or tool usage rather than estimating streaming spend. Missing provider cost is represented as `unavailable`, never as zero. Aggregate cost must indicate when it is incomplete because one or more variants have unavailable cost.

V1 records spend but does not enforce a cost limit. A future cost limit can use this evidence, with the expectation that enforcement can occur only after finalized provider usage and may therefore overshoot the configured amount.

Normal retries, compaction, and nested tool usage must be included when Pi reports their usage.

## Tool-call and approach analysis

The evaluator performs deterministic extraction only. It must not invoke a judge model.

Capture:

- ordered tool timeline;
- tool name, arguments, start/end time, duration, and outcome;
- shell commands;
- paths read, written, or edited;
- retries and repeated commands;
- tool failures;
- files changed by final Git evidence;
- final assistant response.

Reports may summarize these facts, but must link back to raw event and transcript evidence. Do not produce an opaque quality score.

## Artifact layout

```text
~/.pi/agent/skill-evals/<run-id>/
  eval.yaml
  review-rubric.yaml          # only when an optional sibling rubric was provided
  resolved-config.json
  replacements.json
  events.jsonl
  run.json
  failure.json                # only for stopped or failed runs
  report.md
  report.html

  reviews/                    # created later by the reviewer skill
    <review-id>/
      review.json
      review.html

  variants/
    <variant-id>/
      session/
        <pi-session-id>.jsonl
      transcript.md
      system-prompt.md
      system-prompts.jsonl       # only needed when the effective prompt changes
      tool-calls.jsonl
      final-response.md
      diff.patch
      status.txt
      metrics.json
      resources.json
```

`session/<pi-session-id>.jsonl` is Pi's canonical native session file, written incrementally during execution rather than reconstructed after the fact. `transcript.md`, `tool-calls.jsonl`, `metrics.json`, and both reports are reproducible derivatives of canonical evidence.

Disposable common and variant workspaces live under a private temporary run subdirectory while active and are removed after evidence capture. Retained artifacts and append-only versioned reviews have no automatic expiration in V1 and remain until manually removed. A future cleanup workflow may remove them after final analysis and reporting.

Raw artifacts are private but not assumed to be sanitized. They may contain thinking content, hidden extension messages, source excerpts, shell output, prompts, local paths, and secrets printed by tools. Canonical native sessions, textual transcripts, lifecycle events, and Git patches are retained without truncation. Reports summarize and link to complete evidence rather than embedding large evidence bodies.

Do not retain a complete baseline workspace archive, raw provider HTTP requests/responses, authentication configuration, or environment-variable dump. Retain reproducibility metadata instead: Pi/package version, Node version, OS/architecture, Git version, provider/model, thinking level, loaded resources and their paths/digests, and relevant settings paths.

## Report structure

Markdown and HTML reports are generated from the retained artifacts, not directly from live run objects, and use the same information architecture:

1. Eval name, final status, start/end time, and workspace source.
2. Resolved agent/harness configuration.
3. Global replacements and digests.
4. Aggregate cost, tokens, timing, tools, and diff statistics.
5. Per-variant summary table.
6. Per-variant prompt and complete final response.
7. Deterministic ordered tool timeline without complete tool-result bodies, with a relative link to `tool-calls.jsonl` and `transcript.md`.
8. Changed-file and insertion/deletion summary, with a relative link to the complete `diff.patch`.
9. Timeout, policy finding, blocked interaction, retry, compaction, harness error, or cancellation details.
10. Loaded resource manifest.
11. Manual review checklist.
12. Paths to raw evidence.

Neither report embeds the complete transcript, tool-result bodies, or patch. Both use equivalent summaries and relative artifact links, so no arbitrary excerpt threshold is needed. HTML must escape all retained content and must not contain analysis unavailable from the Markdown or raw artifacts.

The report generator must be idempotent: rerunning it against an unchanged evidence directory produces semantically identical Markdown and HTML, apart from explicitly documented generator timestamps if any. Internal tests must prove regeneration works after all live runner state and disposable workspaces have been discarded. A user-facing report-regeneration command is not required for V1, but the report API must make one possible later.

Reports are not opened automatically. Their paths are printed after the user closes the completed monitor.

## Separate semantic reviewer

The `skill-eval-reviewer` skill owns semantic review after execution. `/skill-eval review <run-id|path|latest>` is a thin resolver and dispatcher: it verifies settled retained evidence, expands the skill explicitly in the current session, and leaves review IDs, structured analysis, rendering, and completion reporting to the skill.

### Authored rubric sidecar

For `example.yaml`, the optional reviewer-only sidecar is `example.review.yaml`; `.yml` inputs preserve that extension. Its strict version-1 schema contains:

- a required review objective;
- optional shared observable expectations;
- optional per-variant expected outcomes, prohibited outcomes, and evidence hints.

Every sidecar variant ID must exist in the execution YAML. The runner copies a valid sidecar to `review-rubric.yaml`. It never injects rubric content into a child prompt, system prompt, or context file. This is not a secrecy boundary: if the author stores the eval and sidecar inside the evaluated workspace, ordinary workspace copying leaves those source files discoverable to tools. Store them outside the workspace when expectation secrecy matters. Without a sidecar or variant entry, the reviewer infers only expectations supported by the prompt and retained guidance, labels them inferred, and lowers confidence when intent is ambiguous.

### Common review rubric

Every applicable expectation and criterion receives `met`, `partially_met`, `not_met`, `inconclusive`, or `not_applicable`, with evidence citations. Variant semantic outcomes are `meets_expectations`, `partially_meets_expectations`, `does_not_meet_expectations`, `inconclusive`, or `not_run`. Run-level review may additionally be `mixed`. Confidence is high, medium, or low. No numeric score or weighted aggregate is produced.

The fixed criteria are outcome correctness, guidance adherence, investigation, change quality, verification, final-response accuracy, efficiency, safety/policy, and evidence sufficiency. Operational status informs but never mechanically determines a semantic outcome.

### Review evidence and presentation

The reviewer defaults to artifacts inside the retained run. It never silently consults the mutable source workspace or network. Missing support produces an `inconclusive` finding rather than an assumption. Existing execution reports are summaries and do not override canonical evidence.

Each invocation creates a private, versioned directory under `reviews/<UTC-basic-timestamp>-<8-hex-random>/`. The reviewer writes schema-versioned `review.json`; a deterministic script validates it and HTML-escapes it into the common self-contained `review.html` template. The HTML is responsive, printable, light/dark aware, and links to complete evidence rather than embedding raw transcript, tool-result, or patch bodies. Earlier reviews are never replaced.

## Execution outcome, limits, and cancellation semantics

The harness does not label an agent answer as semantically passed or failed. The separate reviewer skill may assign semantic outcomes afterward using retained evidence. V1 execution records operational status and policy findings:

```text
executionStatus: completed | timed_out | interaction_blocked | cancelled | harness_error
policyFindings: tool_policy_violation[]
```

A `completed` status means only that Pi reached a settled terminal response. No file changes, an incorrect answer, or ordinary tool errors do not change that status. Cost is recorded but not enforced in V1.

### Preparation harness error

- No model tokens are spent.
- Mark the run as a harness error and record the exact phase and error.
- Generate a partial report when a run directory already exists.
- Print the run directory after the monitor closes.

### Completed variant

- Retain the complete response and evidence regardless of answer quality or whether files changed.
- Continue to the next variant only when execution completed without a blocking policy finding.
- Leave semantic evaluation to the separate reviewer skill.

### Tool-policy finding

- A policy exists only when `agent.tools` provides an explicit allowlist.
- Do not intentionally expose tools outside that allowlist.
- If Pi/model output nevertheless attempts another tool, block execution and return a denied tool result to the active session.
- Record tool name, arguments, timestamp, and denial as `tool_policy_violation` evidence.
- Allow the active session to continue to a terminal response so its recovery behavior is analyzable.
- After the active session settles, do not start another variant; generate a partial run report.
- A shell command that performs an analogous operation is not an out-of-allowlist tool call; ordinary safety extensions remain responsible for command confirmation.

### Timeout

- `limits.timeoutSeconds` applies independently to each variant and defaults to 300 seconds.
- Start active-execution timing when Pi accepts the user prompt.
- Include model calls, tool execution, retries, and compaction.
- Pause the execution timer while an evaluator-owned interactive child dialog waits for a human answer; record that wait separately and continue recording total wall time.
- On expiry, abort the active SDK session and mark it `timed_out`.
- Do not start another variant.
- Capture partial transcript, metrics, status, and diff before cleanup.

### Blocked custom interaction

- In `dialogs: auto-reject` mode, standard confirm/select/input/editor requests receive deterministic safe rejection or cancellation values.
- If a generic custom dialog has no API-defined cancellation value, record its metadata and mark the variant `interaction_blocked` rather than returning an invented value.
- Abort the active session, capture partial evidence, and do not start another variant.
- This is an operational policy outcome, not a semantic eval judgment or harness defect.

### Harness error during a variant

- Mark the active variant `harness_error`.
- Do not start remaining variants.
- Capture all available evidence and identify the failing harness phase separately from agent behavior.
- Generate a partial report and keep the monitor open in its final state.

### User cancellation

- Escape requests cancellation.
- Abort the active Pi SDK session.
- Propagate cancellation to evaluator-owned Git/copy operations where possible.
- Do not start another variant.
- Capture partial evidence and reports.
- Remove disposable workspaces.
- Keep the monitor open in cancelled state until the user closes it.

### Process crash

There is no durable controller or resumable background worker. A parent Pi process crash stops the run. Append evidence incrementally so already-recorded events remain inspectable, but V1 does not resume interrupted runs.

## Explicit non-goals

- fixture setup commands;
- preparation scripts;
- Git ref resolution;
- preservation of source Git history;
- broad symlink, submodule, or LFS validation;
- sandboxing or evaluator-owned network policy;
- multiple agent configurations in one eval;
- parallel variants within a run;
- a global queue or lock across independently invoked runs;
- background or detached runs;
- resumable runs;
- automated grading or judge models in the execution harness;
- cost-limit enforcement in V1;
- repetitions or scenario matrices;
- ignored-file diffs;
- steering or follow-up messages from the monitor;
- a separate `/skill-eval monitor` command;
- automatic artifact expiration or cleanup in V1;
- complete baseline workspace archives;
- raw provider transport capture or environment-variable dumps.

## Proposed implementation layout

Keep implementation local to the extension because it is not shared by other extensions:

```text
extensions/evals/skill-eval/
  index.ts          # command parsing and UI entry points
  config.ts         # existing strict YAML loader
  events.ts         # normalized event types and event bus
  storage.ts        # private run directories and artifact paths
  workspace.ts      # copy, replacement, baseline, diff, cleanup
  harness.ts        # Pi SDK session creation and event adaptation
  metrics.ts        # deterministic usage/timing aggregation
  recorder.ts       # run index, canonical evidence, native session, and derived writes
  monitor.ts        # full-screen live TUI
  reporting.ts      # Markdown and HTML generation
  runner.ts         # sequential lifecycle orchestration
```

Semantic-review instructions and presentation stay reusable and separate from the execution extension:

```text
skills/skill-eval-reviewer/
  SKILL.md
  references/common-rubric.md
  assets/review-rubric.yaml
  assets/review.schema.json
  assets/review-template.html
  scripts/render-review.mjs
```

Tests remain under `tests/` and should use temporary directories and fake session/event sources whenever possible.

## Implementation phases and checkpoints

### Phase 1: Run model, events, and storage

- Extend the strict YAML schema with optional `limits.timeoutSeconds` and `dialogs`, applying defaults of `300` and `interactive` in the resolved configuration.
- Test valid overrides, invalid/non-positive timeout values, unknown limit fields, and invalid dialog modes.
- Define run/variant operational status, policy-finding models, limits, and normalized events without semantic pass/fail.
- Add private run-directory creation and artifact-path helpers.
- Add incremental recorder with atomic summary writes.
- Add versioned `run.json` indexing operational status, artifact completeness, and relative canonical/derived paths.
- Persist native Pi sessions under each variant artifact directory.
- Unit-test state transitions, event serialization, partial `run.json`, and private permissions.

Checkpoint: inspect the event schema and artifact layout before building the runner.

### Phase 2: Workspace preparation and diff

- Implement copy-on-write clone plus fallback.
- Implement safe whole-file replacements and manifest.
- Implement fresh Git baseline.
- Implement final patch/status/stat capture against baseline SHA.
- Implement cleanup and cancellation boundaries.

Tests:

- source workspace remains unchanged;
- generated and ignored files remain available;
- replacement creates absent target parents;
- replacement does not follow a target symlink;
- a parent symlink cannot escape the disposable workspace;
- dirty source content becomes part of the baseline;
- agent commits do not hide changes from the final patch;
- untracked nonignored files appear in the patch;
- ignored file changes are omitted;
- cancellation cleans temporary workspaces.

Checkpoint: manually inspect patches from a representative prepared workspace before adding model execution.

### Phase 3: Pi SDK harness

- Resolve model/authentication at runtime.
- Create one fresh persisted session per variant, scoped to the retained run artifacts rather than Pi's ordinary session history.
- Load normal Pi resources, settings, and explicit harness overrides.
- Submit each YAML prompt as one ordinary user turn.
- Enforce the per-variant timeout, defaulting to 300 seconds.
- Detect, block, return a denied result for, and record out-of-allowlist tool attempts while allowing the current session to continue.
- Bind a scoped child-extension UI proxy with interactive and safe auto-reject modes.
- Adapt SDK events into normalized events.
- Collect final response, usage, tools, and resource metadata.
- Dispose sessions reliably.

Tests cover timeout, tool-policy findings, unavailable cost, prompt placement as a user message, normal Pi settings, UI isolation, and both dialog modes. They should use a fake model/provider or fake session adapter; no ordinary unit test should spend tokens.

Checkpoint: run one disposable synthetic variant and compare its resources and tool behavior with a normal Pi session.

### Phase 4: Monitor

- Implement full-screen responsive component.
- Render native user, assistant, and tool components.
- Add a non-selectable detailed variant table and aggregate operational metrics.
- Add scrolling, auto-follow, keybinding-aware Ctrl+O, and cancellation.
- Add nested child-extension dialog focus restoration, paused timeout accounting, and safe auto-reject behavior.
- Add completed, policy-finding, timed-out, interaction-blocked, harness-error, and cancelled states without implying semantic pass/fail.
- Clean up timers, subscriptions, overlays, and child UI state.

Tests:

- render lines never exceed width;
- wide and narrow layouts;
- long variant names;
- tool expansion toggling;
- scrolling and auto-follow;
- streaming message/tool updates;
- Escape cancellation;
- completion remains visible until close;
- child dialog returns focus without mutating the parent session;
- safe auto-reject records deterministic rejected/cancelled answers;
- an uncancellable custom dialog produces `interaction_blocked` and partial evidence;
- interactive dialog wait pauses execution timeout while wall time remains accurate;
- timer/subscription disposal.

Checkpoint: interactive manual QA with a fake timed event stream before connecting real model spend.

### Phase 5: Reports

- Generate a complete human-readable transcript from native session and lifecycle evidence.
- Generate deterministic Markdown and escaped HTML using only retained artifacts.
- Add variant summaries, final responses, tool analysis, metrics, diffs, and resource manifests.
- Generate partial reports for timeout, policy findings, blocked interactions, harness errors, and cancellation.
- Add report-path notification after monitor close.

Tests:

- stable report snapshots;
- report regeneration after deleting all in-memory run state and disposable workspaces;
- native session completeness, including thinking, tools, hidden custom messages, and compaction entries;
- transcript derivation and labeling;
- HTML escaping;
- partial evidence;
- large transcript/diff handling through summaries and valid relative artifact links;
- cost and token aggregation.

Checkpoint: manually review both formats from synthetic completion, timeout, policy-finding, interaction-blocked, harness-error, and cancellation runs.

### Phase 6: Command integration and end-to-end QA

- Add `/skill-eval run <eval.yaml>` parsing and completion.
- Reject non-TUI run mode clearly.
- Connect validation, runner, monitor, recorder, cleanup, and reporting.
- Update `docs/skill-evaluation.md` and README.
- Validate with `npm run validate`.
- Run one deliberately small real eval only after synthetic end-to-end QA passes.

### Phase 7: Separate semantic reviewer

- Add strict optional same-basename rubric discovery and retention.
- Define the common ordinal rubric and evidence/confidence rules.
- Add a conversational reviewer skill with an artifacts-only default.
- Define schema-versioned `review.json` as canonical review output.
- Add a deterministic renderer and common self-contained HTML template.
- Preserve each review under a private versioned directory.
- Update the eval-creator skill to offer authored rubric sidecars.

Tests cover optional sidecars, schema errors, unknown rubric variants, retention, complete common criteria, citation containment, HTML escaping, and relative evidence links.

## Acceptance criteria

Before calling V1 usable:

- Starting a run always opens the monitor.
- Escape reliably stops the active model session and prevents later variants.
- The source workspace and source Git metadata remain unchanged.
- Global replacements are applied identically to every variant baseline.
- A missing target is created successfully.
- Every variant receives a fresh workspace and fresh session persisted only inside its retained evidence directory.
- The live monitor shows native streaming assistant and tool activity.
- Ctrl+O uses the configured Pi keybinding and expands/collapses tool output.
- Detailed non-selectable progress, elapsed time, variant spend, and total spend update correctly.
- Missing provider cost is shown as `unavailable`, never zero.
- Interactive child dialogs appear and return focus without modifying the parent session.
- Safe auto-reject deterministically rejects or cancels standard child dialogs and records the interaction.
- An uncancellable custom dialog in auto-reject mode stops as `interaction_blocked` without inventing a result.
- The default 300-second timeout and configured per-variant override abort correctly and stop later variants; interactive dialog wait is paused out and reported separately.
- Out-of-allowlist tool attempts are denied and recorded while the current session may continue to its terminal response.
- A final patch includes committed and uncommitted Git-visible agent changes.
- Timed-out, policy-finding, interaction-blocked, harness-error, and cancelled runs retain inspectable partial artifacts.
- The complete native Pi session and a human-readable full transcript are retained for every started variant.
- Markdown and HTML execution reports can be regenerated using only retained evidence and agree with it.
- Optional reviewer sidecars are strictly validated, retained, and never submitted to the evaluated agent.
- Reviewer output uses every common criterion, ordinal outcomes, explicit confidence, and evidence citations without numeric scoring.
- `review.json` validates before the shared HTML template is rendered, all retained content is escaped, and citation links stay inside the run directory.
- Each semantic review is preserved in a new private `reviews/<review-id>/` directory and defaults to retained artifacts only.
- No semantic judge model in the execution harness, detached process, fixture setup, hidden validation, cost enforcement, or automatic artifact cleanup is introduced.

## Remaining V1 decisions

None. Product behavior and implementation-level defaults required to begin V1 are finalized.

## Deferred beyond V1

- optional cost-limit enforcement after spend evidence has been tested;
- a user-facing report-regeneration command;
- analysis-agent-driven artifact cleanup after final reporting;
- cross-run comparison reports;
- parallel variants or a global run queue;
- configurable auto-answer rules beyond interactive and safe auto-reject modes.

Do not add config fields for deferred features without a separate schema decision.

## Decision log

| Decision | Outcome |
|---|---|
| Configuration format | YAML |
| Prompt placement | Inline, per variant, submitted as one ordinary user message; never system/context replacement |
| Agent configurations | One per eval |
| Variant execution | Sequential within a run; independently invoked runs may coexist |
| Run ID | UTC basic timestamp + sanitized eval name + 8 random hex characters |
| Workspace copy | Recursive `fs.cp` with clone-on-write request and safe ordinary-copy fallback; preserve timestamps and symlinks |
| Replacement scope | Global to eval |
| Replacement operation | Whole-file copy only |
| Skills YAML field | Omitted; normal discovery |
| Git baseline | Fresh disposable repository; no source history |
| Diff scope | Git-visible files only |
| Pi resources | Normal discovery, including extensions |
| Semantic outcomes | Separate `skill-eval-reviewer` workflow; execution harness records status/findings only |
| Operational stop conditions | Timeout, cancellation, harness error, or completed variant with tool-policy finding |
| Tool-policy violation | Deny the call, return a denied result, allow current session to continue, then stop later variants |
| Timeout | Global eval setting applied to active execution per variant; defaults to 300 seconds and pauses for interactive child-dialog wait |
| Cost enforcement | Deferred; missing cost is `unavailable` |
| Workspace retention | Delete disposable workspaces after evidence capture |
| Artifact retention | Indefinite until manually removed |
| Run mode | Foreground only |
| Monitor | Always shown, full-screen |
| Monitor progress | Detailed non-selectable per-variant view; transcript shows active/final attempted variant |
| Monitor completion | Stay open until user closes |
| Tool expansion | Pi `app.tools.expand` keybinding, Ctrl+O by default |
| Child-extension dialogs | `interactive` by default or safe `auto-reject`; scoped proxy cannot modify parent session; uncancellable custom UI becomes `interaction_blocked` |
| Evidence index | Versioned `run.json`; no separate per-file manifest in V1 |
| Evidence role | Canonical inputs first; analysis and reports are reproducible derivatives |
| Session transcript | Native Pi session JSONL plus deterministic full Markdown transcript |
| System prompt evidence | Initial effective prompt plus changed per-turn snapshots |
| Evidence exclusions | No workspace archive, provider transport capture, auth config, or environment-variable dump |
| Reports | Markdown and HTML contain full final responses plus summaries and relative evidence links; complete transcripts, tool results, and patches remain separate and untruncated |
| Reviewer rubric | Optional same-basename sidecar, validated and retained but never submitted to the evaluated agent |
| Review outcomes | Ordinal and evidence-cited with no numeric score; artifacts-only by default |
| Review reports | Versioned `review.json` plus deterministic shared `review.html` under `reviews/<review-id>/` |
| Reviewer invocation | Explicit `/skill-eval review <run-id|path|latest>` dispatch in the current idle session; active runs rejected |
| Grading | Separate reviewer skill only; no semantic grading in execution harness |
