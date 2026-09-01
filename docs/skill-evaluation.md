# Skill evaluation

The skill-evaluation extension validates and runs one configured Pi agent sequentially across prompt variants.

```text
/skill-eval validate path/to/eval.yaml
/skill-eval run path/to/eval.yaml
```

Command paths may be relative to Pi's current working directory, absolute, quoted when they contain spaces, or home-relative with `~/`.

`run` requires interactive TUI mode. It opens a read-only full-screen monitor, keeps it open after the run settles, and stores private evidence under `~/.pi/agent/skill-evals/<run-id>/`. Press Escape while running to cancel; after settlement, press Enter or Escape to close.

## YAML format

```yaml
version: 1
name: package-architecture
workspace: ../../

agent:
  harness: pi
  model: anthropic/claude-sonnet-4-5
  thinking: medium
  tools: [read, bash, edit, write]

limits:
  timeoutSeconds: 300
  onTimeout: retry # stop, continue, or retry
  maxRetries: 1

dialogs: interactive # or auto-reject

replacements:
  - source: setup/Package.swift
    target: Packages/Feature/Package.swift

removals:
  - Packages/Feature/Legacy.swift

variants:
  reject-production-dependency:
    prompt: |
      Determine whether the requested dependency is permitted. Make the change
      if appropriate; otherwise explain why it is prohibited.
```

`workspace` and each replacement `source` resolve relative to the YAML file. Replacement targets and removal entries resolve relative to the workspace. Replacement sources must be existing files. Replacement targets and their parent directories may be absent because execution creates them in a disposable copy. Removals delete files (or symlinks) before the baseline commit; missing targets are a no-op, while directory targets are rejected.

`replacements`, `removals`, `agent.thinking`, `agent.tools`, `limits`, and `dialogs` are optional. The timeout defaults to 300 active-execution seconds and pauses while an interactive child-extension dialog waits for an answer. `limits.onTimeout` defaults to `stop`; use `continue` to continue with later variants after a timeout, or `retry` with `maxRetries` (default 1) to retry the timed-out variant from the prepared baseline. An exhausted retry policy stops the run. Timed-out retry attempts are retained under `variants/<id>.attempt-<n>/`; the standard variant evidence holds the final attempt. `maxRetries` is valid only with `onTimeout: retry`. Dialog behavior defaults to `interactive`; `auto-reject` safely declines standard dialogs and stops the run if generic custom UI cannot be cancelled safely.

At least one prompt-bearing variant is required. Variant names are filesystem-safe identifiers containing letters, digits, `.`, `_`, or `-`. The only supported harness is `pi`.

Validation intentionally does not inspect replacement targets, Git state, model availability, tool availability, symlinks, or project contents.

## Optional reviewer rubric

A same-basename sidecar can preserve the eval author's semantic intent without sending grading instructions to the evaluated agent:

```text
package-architecture.yaml
package-architecture.review.yaml
```

For `.yml`, preserve that extension. `/skill-eval validate` automatically validates the sidecar when present, and `run` retains it as `review-rubric.yaml`. The sidecar is optional; absent or omitted variant expectations are inferred later with lower confidence.

```yaml
version: 1
objective: >
  Determine whether package-architecture guidance produces the correct
  dependency-placement decision.
sharedExpectations:
  - Follow applicable project guidance.
  - Avoid unrelated changes.
variants:
  reject-production-dependency:
    expected:
      - Reject the prohibited dependency.
      - Leave the workspace unchanged.
    prohibited:
      - Add the dependency despite project guidance.
    evidenceHints:
      - final response
      - Git patch
```

`objective` is required. `sharedExpectations` and `variants` are optional. Each rubric variant ID must match a variant in the sibling eval. Expectations must be observable; `evidenceHints` guide review but do not prescribe evaluated-agent behavior.

The harness does not inject the sidecar into the evaluated prompt or context, but this is not a secrecy boundary. If the eval and sidecar live inside the evaluated workspace, ordinary workspace copying leaves them discoverable to tools. Store them outside that workspace when expectation secrecy matters.

## Execution and evidence

Each run:

1. Copies the source workspace without modifying it.
2. Captures the source workspace's Git remote and branch, applies whole-file replacements and file removals, and commits a fresh disposable Git baseline. Eval usage is attributed to that source project and branch, and always includes the `skill-eval` tag; a source `.pi/usage.json` may explicitly override either value and supply additional default tags.
3. Runs each variant in an independent workspace and persisted Pi session.
4. Captures the agent's Git-visible patch, transcript, tools, resources, timing, tokens, and provider cost when available.
5. Generates Markdown and HTML reports from retained artifacts, then deletes disposable workspaces.

Operational statuses and policy findings do not imply semantic pass or failure. A timeout, cancellation, harness error, blocked interaction, or disallowed-tool finding prevents later variants from starting.

Reports contain complete final responses and concise summaries with relative links to full evidence. Native Pi sessions, `transcript.md`, tool JSONL, lifecycle events, and patches remain separate and untruncated. Artifacts are retained until manually removed.

## Diagnose a stopped run

A stopped run retains `failure.json` and links it from both reports. The file records the exact failure phase, structured error name/message/stack/cause, subprocess code/signal/stdout/stderr when available, the final lifecycle event, variant errors and policy findings, artifact completeness, and phase-specific diagnostic hints.

Start with the completion notification or report summary, then inspect `failure.json`. Use `events.jsonl` for ordering and the affected variant's `resources.json`, native session, transcript, and tool evidence for deeper provider, extension, dialog, or tool diagnosis. Initialization failures include the diagnostic directory in the surfaced error even when normal report generation could not start.

## Review a retained run

Dispatch the reviewer skill from the current Pi session with an exact run ID, a path under retained storage, or the explicit `latest` selector:

```text
/skill-eval review <run-id>
/skill-eval review ~/.pi/agent/skill-evals/<run-id>
/skill-eval review latest
```

The argument is required; invoking `review` without one lists recent runs. `latest` selects the lexically newest retained run. Runs still marked `preparing` or `running` are rejected so the reviewer never races changing canonical evidence.

The subcommand resolves and validates the run before explicitly expanding `skill-eval-reviewer` as the next user turn. Review therefore uses the current session's model, thinking level, tools, and conversation context; the skill still enforces retained artifacts as its evidence boundary. It applies the authored sidecar when available and otherwise labels expectations as inferred. Reviews use ordinal, evidence-cited findings rather than numeric scores.

Each invocation preserves a new review under:

```text
<run>/reviews/<review-id>/
  review.json
  review.html
```

`review.json` is the validated structured analysis. `review.html` is generated deterministically with the shared, self-contained template. The reviewer does not modify canonical run evidence or silently inspect the current source workspace.

See [the implementation plan](skill-evaluation-implementation-plan.md) for the detailed evidence and monitor contract.
