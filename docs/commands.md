# Command reference

This document lists the slash commands provided by `pise-en-place`. It does not include Pi's built-in commands or package tools invoked by the model. Run a command without required arguments, or with `--help` where supported, for inline guidance.

After changing or installing extensions, run Pi's built-in `/reload` command.

## Quick reference

| Command | Purpose |
| --- | --- |
| [`/safety`](#safety) | Show or toggle safety permission prompts for the current session |
| [`/usage`](#usage) | Usage ledger reports, Codex subscription limits, session tags, and skill-read reports |
| [`/skillz`](#skillz) | Check, select, and install agent skill updates |
| [`/skill-review`](#skill-review) | Retain independent skill reviews and automatically consolidate them |
| [`/skill-eval`](#skill-eval) | Validate, run, and review skill evaluations |
| [`/subagents`](#subagents) | List retained child sessions created by the subagent tool |
| [`/team`](#team) | Join and manage an isolated coordination room |
| [`/todos`](#todos) | Manage the current session's todo list and widget |
| [`/context`](#context) | Inspect or configure context-file, skill, and private-guidance filtering |
| [`/pr`](#pr) | Show the GitHub PR for the current branch |
| [`/jira-worktree`](#jira-worktree) | Create and open a Supacode worktree for a Jira item |
| [`/share-local`](#share-local) | Export the current session to local HTML |
| [`/md`](#md) | Render a Markdown file in the conversation |
| [`/roadmap`](#roadmap) | Delegate a focused `ROADMAP.md` update |
| [`/statusline`](#statusline) | Cycle the custom footer or trace context readings |
| [`/statusline-colors`](#statusline-colors) | Preview context-indicator colors |
| [`/response-time`](#response-time) | Toggle response-duration reporting |

## Safety

### `/safety`

`/safety` reports whether safety permission prompts are on. `/safety toggle` switches them off or back on for the active session. Prompts are on by default; turning them off allows risky bash commands (including user bash) and protected-file writes without this extension's confirmation, even without an interactive UI. Other extensions' confirmations are unaffected. The setting is stored in the session branch, survives `/reload` and session resume, and resets to on in new sessions or branches without the toggle entry.

The same checks and toggle apply to `bash`, `write`, and `edit` calls nested inside codemode. The script itself is not separately gated. Concurrent hazardous calls share a single safety-decision queue with user bash, so each approval belongs to one operation. Cancelling the originating turn dismisses its active safety dialog and blocks its queued hazardous calls without further prompts. Harmless calls do not wait for this queue. Other custom and MCP tools remain outside this extension's checks.

## Usage and skills

### `/skill-review`

```text
/skill-review <skill-name>
/skill-review </absolute/path/to/skill-directory>
/skill-review </absolute/path/to/skill/SKILL.md>
/skill-review <skill> --focus "additional review criteria"
/skill-review <skill> --prompt <path/to/prompt.md>
/skill-review <skill> --show-prompt
/skill-review --help
```

Opens a new tab in the current Supacode worktree with independent, read-only, one-shot Pi, Codex, and Claude reviews plus an automatic consolidated review in a fourth pane. Each reviewer keeps its normal native CLI session so the session can be revisited later. The command does not edit the skill. Tab completion suggests currently loaded skills by name and shows their descriptions; entering an absolute path continues to use normal path completion.

The read-only `skill_review_prompt` agent tool resolves a skill and returns the exact prompts this command would send without launching reviewers. Agents are instructed to use it before asking for additional focus areas or proposing a replacement prompt. It accepts `skill` plus optional `focus` and `promptPath` parameters.

Every invocation creates a private retained run under:

```text
~/.pi/agent/skill-reviews/<skill-name>/<run-id>/
  run.json
  prompts/
    pi.md
    codex.md
    claude.md
    consolidated.md
  pi.md
  codex.md
  claude.md
  consolidated.md
```

The activating Pi session displays a live above-editor report while the run is active. It shows Pi, Codex, and Claude as working, finished, failed, or timed out, then shows when consolidation is waiting, working, or finished. The final complete or partial report remains visible until another skill review starts or the session reloads.

The exact reviewer and consolidator prompts are retained under `prompts/`. Reviewer stderr logs and status JSON files are retained alongside the outputs. `run.json` records the resolved skill, prompt options, artifact paths, reviewer outcomes, native session IDs and files, effective model/provider metadata, and overall completion status. Pi and Claude session IDs are assigned before launch; Codex's thread ID is captured from its structured event stream. The consolidation pane waits up to 30 minutes for all reviewers to settle, notes failures or timeouts, verifies findings against the skill, and produces a deduplicated prioritized action plan. Reviewer output is both displayed in its pane and captured in the run directory.

`--focus` appends an `Additional review focus` section to the prompt sent identically to all three reviewers. Quote multi-word focus text. `--prompt` replaces the built-in prompt with the non-empty contents of a `.md` or `.markdown` file; its path may be absolute, relative to the current directory, or start with `~/`. `--focus` and `--prompt` may be combined.

`--show-prompt` resolves the skill and opens a read-only preview of the exact three prompts that would be used, without launching reviewers. It may be combined with `--focus` and `--prompt` to inspect the fully composed prompts before launching a review.

`--help` (or `-h`) displays command usage, options, and the retained-output location without resolving a skill or launching reviewers.

A bare name resolves the first readable `SKILL.md` in this order:

1. `<repository>/skills/<name>/SKILL.md`
2. `<repository>/.agents/skills/<name>/SKILL.md`
3. `~/.agents/skills/<name>/SKILL.md`

Skill path inputs must be absolute; a directory must contain a readable `SKILL.md`. Launching reviews requires interactive Pi running in Supacode, a Git worktree, and available `supacode`, `pi`, `codex`, and `claude` executables. The `--show-prompt` preview only requires interactive Pi and the Git worktree used to resolve the skill.

### `/usage`

Tracks new assistant, tool/nested-model, compaction, branch-summary, and separate usage-entry metadata in the existing `~/.pi/agent/usage/ledger.jsonl`. JSONL remains version 1 with optional source-kind fields; counts mean usage records, not exact provider requests. Prompt, response, tool-result, and summary contents are not stored.

#### Summaries

```text
/usage
/usage today
/usage week
/usage month
/usage lifetime
```

`/usage` defaults to month-to-date. Summary filters can be combined where meaningful:

```text
/usage month --project <project>
/usage today --model <model>
/usage lifetime --project <project> --model <model>
/usage month --branch
/usage month --project <project> --branch <branch>
```

A bare `--branch` resolves the current workspace's project and Git branch. An explicit branch requires a project because branch names are not globally unique.

#### Grouped reports

```text
/usage report [today|week|month|lifetime]
/usage report [range] --project <project>
/usage report [range] --model <model>
/usage report [range] --visual
/usage report [range] --json
```

Reports group usage by provider, model, and project and show the most expensive usage records. `--visual` produces terminal-friendly horizontal graphs and cannot be combined with `--json`.

#### Projects and models

```text
/usage project
/usage project --list
/usage project <project>
/usage project <project> --branch [<branch>]
/usage model --list
/usage model <model>
```

A project command without a project opens an interactive selector. Project reports include branch and tag breakdowns when available.

#### OpenAI Codex subscription limits

```text
/usage openai
/usage openai --json
```

Fetches the current plan type, rolling usage windows, reset times, and model-specific additional limits returned by OpenAI. Each invocation makes a fresh request; there is no persistent widget, startup request, post-response polling, or result cache.

Credentials, raw responses, and limit readings stay in memory and are not added to the ledger or session file. The integration reuses Pi's `openai-codex` OAuth login and calls OpenAI's undocumented `/backend-api/wham/usage` endpoint. If it changes or is unavailable, the command reports unavailable rather than zero.

#### Skill reads

```text
/usage skills [today|week|month|lifetime]
/usage skills --project <project>
/usage skills --project
/usage skills --json
```

Reports explicit skill commands and skill-file reads recorded in `~/.pi/agent/skill-reads/ledger.jsonl`. A bare `--project` groups by project; a value filters to one project. Prompt and skill contents are not stored.

#### Session tags

```text
/usage tag <comma-separated tags>
/usage tag --list
/usage tag --remove <tag>
/usage tag --clear
```

Tags are session-scoped and apply only to subsequent usage records. They are stored in private Pi session entries so they survive navigation within that session. Quote a tag containing spaces.

#### Clearing the ledger

```text
/usage clear
/usage clear --yes
```

Deletes `~/.pi/agent/usage/ledger.jsonl`. Interactive use asks for confirmation; `--yes` is required when no confirmation UI is available.

Most `/usage` outputs support `--json`. See [usage tracking](usage-tracking.md) and [skill-read tracking](skill-read-tracking.md) for the complete data model and privacy details.

### `/skillz`

```text
/skillz update [--respect-interval]
/skillz check
/skillz interactive
/skillz disable <skill_path>
/skillz disable --list
/skillz session --disable
/skillz session --enable
/skillz --help
```

`--help` and `-h` are accepted by the command and each subcommand.

- `update`: runs the local skill sync script with `--force` by default. Pass `--respect-interval` to honor its configured interval instead.
- `check`: checks version-pinned manifest sources for newer refs without installing them.
- `interactive`: requires interactive UI, opens a selector, updates accepted manifest refs, and syncs the selected changes.
- `disable <skill_path>`: accepts a project-local skill directory or `SKILL.md` path and adds its skill name to the current project's existing context-filter ignore list in `~/.pi/agent/settings.json`. Tab completion suggests currently discovered project skill directories by name and path. It removes the skill from model context and blocks `/skill:<name>`, direct Pi file tools, and literal shell references to every file within that skill directory. Pi may still discover it and expose its command in the startup UI. This is workflow enforcement, not an OS security sandbox against arbitrary or obfuscated shell access.
- `disable --list`: lists managed skills with `enabled: false` in `~/.agents/skills/manifest.json` and the effective disabled skills for the current Git project.
- `session --disable`: bypasses all project disabled-skill filtering and access guards for the current in-memory session and shows `skillz: blocking off` above the editor. Disabled skills return to model context, `/skill:<name>` works, and direct file, shell, and subagent access is allowed. The override resets on `/reload`, `/new`, `/resume`, `/fork`, or process restart and does not modify settings.
- `session --enable`: restores disabled-skill filtering and access guards immediately.

The extension also checks pinned versions once at normal session startup, but skips duplicate checks on `/reload`. It uses `~/.agents/skills/manifest.json` by default and delegates mutations/install work to the scripts under `~/.agents/scripts/`.

## Evaluation and orchestration

### `/skill-eval`

```text
/skill-eval validate <eval.yaml>
/skill-eval run <eval.yaml>
/skill-eval review <run-id|path|latest>
```

- `validate` resolves paths and validates the eval configuration, replacement/removal declarations, optional review rubric, timeout policy, and dialog mode. It does not execute variants.
- `run` requires TUI mode and opens a full-screen monitor. Variants run sequentially in disposable Git workspaces.
- `review` requires the current agent to be idle. It resolves retained evidence and queues the `skill-eval-reviewer` workflow in the current session.

Runs are retained under `~/.pi/agent/skill-evals/<run-id>/` with configuration snapshots, events, native Pi sessions, status/evidence files, and Markdown/HTML reports. Failed runs also retain structured failure evidence. See [skill evaluation](skill-evaluation.md).

### `/subagents`

```text
/subagents
```

Lists child sessions retained by the package's `subagent` tool for the current parent session, including the command needed to inspect each child. The command itself is read-only. Child sessions live under `~/.pi/agent/subagent-sessions/<parent-session-id>/`.

## Team coordination

### `/team`

`/team` without arguments is equivalent to `/team status`. One Pi session can join one room; separate Pi sessions can join other rooms.

```text
/team help
/team join <room> --name <name> [--role <role>] [--rejoin]
/team leave
/team status [joined-room] [participant-id]
/team dashboard
/team inbox [cursor] [--history]
/team thread <thread-id> [cursor]
/team read <message-id>
/team deliver <message-id>
/team reconcile <message-id>
/team retry <message-id>
/team review <message-id>
/team resolve <thread-id>
/team pause [local|room|project]
/team resume [local|room|project]
```

#### Membership and inspection

- `join` starts or reuses the local broker, confirms enrollment, and stores the binding in the Pi session. The role defaults to `worker`. `--rejoin` recovers the mailbox for an existing disconnected/left identity; it cannot take over a live identity.
- `leave` stops delivery to this session but retains broker history and pending messages for an explicit rejoin.
- `status` shows roster, presence, current work/blockers, requests, and attention counts. To request a participant's full work text, supply the joined room name/ID followed by the participant ID.
- `dashboard` opens a centered interactive TUI overview. It loads status and the active inbox once, refreshes explicitly with `r` and after actions or view changes, supports active/history paging and scrollable message detail, and reuses existing confirmation/review behavior. Opening or inspecting it does not acknowledge, deliver, or run an agent.
- Argument completion is local, bounded session-memory metadata only: it suggests known current-room, participant, message, and thread IDs but never discovers rooms or queries the broker while typing.
- `inbox` shows active items by default; `--history` includes inactive and acknowledged history. `thread` pages one discussion. `read` retrieves one full message without delivering it to the agent.

#### Delivery and recovery

- `deliver` records one addressed message into agent context at an idle boundary without immediately running the model.
- `reconcile` checks durable delivery evidence and avoids duplicate insertion when a matching receipt exists.
- `retry` is an explicit recovery action for an uncertain delivery and may duplicate prior work; it requires confirmation when no receipt is found.
- `review` opens a TUI workflow to keep waiting, answer as a human, redirect within the room, or cancel a request.
- `resolve` closes a discussion's open response obligations. It is not protected decision approval.

#### Pausing and automatic behavior

- `pause`/`resume` default to the local participant. `room` is broker-wide; the currently accepted `project` spelling behaves as an alias for the joined room rather than identifying a separate project scope.
- Eligible questions, decision requests, requested replies, and actionable handoffs can wake an idle recipient automatically. Informational messages do not.
- Busy work is not interrupted. Aborting an automatic run pauses local automation.
- Automation is bounded to 100 activations per room in a rolling hour, with no lifetime thread cap.

Membership entries and inspection/delivery evidence are durable, and the broker retains room history and receipts. Automatic membership restoration currently occurs only during `/reload`; ordinary new/resume/fork startup does not auto-enroll, so explicitly rejoin when needed. The private broker database, socket, and credentials live under the Pi user directory. Human control operations require interactive TUI confirmation. Coordination requires Node 24.15+, Pi 0.87.1+ (the package peer minimum), and macOS or Linux. See [agent coordination](agent-coordination.md) and the [coordination protocol](agent-coordination-protocol.md).

## Session and project productivity

### `/todos`

```text
/todos
/todos list
/todos show
/todos hide
/todos toggle-ui
/todos add <text>
/todos done <id>
/todos undone <id>
/todos toggle <id>
/todos edit <id> <text>
/todos remove <id>
/todos clear
```

`/todos` toggles the widget when todos exist. Mutations are appended as private custom session entries, so the list follows the current session branch and is reconstructed after resume or tree navigation. Widget visibility itself is process-memory state and is not stored with the todo data. `list` is read-only. Todo IDs may be written as `1` or `#1`.

### `/context`

```text
/context
/context status
/context system-prompt
/context project config
```

- No argument or `status`: shows project detection, active filtering, visible/ignored context files and skills, and private-guidance status.
- `system-prompt`: displays the effective system prompt after this extension's context/skill filtering and private-guidance injection. Treat this output as potentially sensitive.
- `project config`: requires interactive UI and opens a questionnaire for enabling the project rule and selecting ignored context files and skills.

Project filter rules are written to global `~/.pi/agent/settings.json` under `contextFileFilter`, keyed by detected project identity. Private guidance is configured separately in `~/.pi/agent/projects.json` through each project's `additional_guidance` path and is never copied into a ledger. See [private guidance](private-guidance.md).

### `/pr`

```text
/pr
```

Uses `git` and authenticated GitHub CLI (`gh`) to find the pull request associated with the current branch, then displays its metadata. It is read-only and requires a Git repository with a GitHub remote.

### `/jira-worktree`

```text
/jira-worktree <JIRA-KEY> [--branch-suffix <slug>]
/jira-worktree -h | --help
```

Requires a Git repository and authenticated `acli`, `supacode`, and `pi` executables. Without `--branch-suffix`, it also requires interactive UI and a selected model.

1. Reads the Jira item and repository root.
2. Uses the supplied branch suffix, or runs an isolated, no-tools Pi process to suggest concise suffixes and lets the user select or enter one.
3. Creates a Supacode worktree using the package's branch convention.
4. Opens a new Supacode tab with Pi started on the Jira context.

The suffix must contain lowercase letters and numbers joined by single hyphens, with a maximum of 48 characters. This command creates a Git worktree and starts another Pi session.

### `/share-local`

```text
/share-local [output-path]
```

Waits for the agent to become idle, exports the complete persisted session tree through supported `pi --export`, and prints an openable local link. Requires the `pi` executable on `PATH`; it uses that CLI's version rather than resolving a repository-local private exporter. A relative path is resolved from the current working directory; `.html` is added when omitted. Without a path, output goes under `~/.pi/agent/sessions/transcripts/` (or the configured Pi agent directory). In-memory sessions cannot be exported.

Export is local-only and does not start a model conversation or upload the transcript. Discovered extensions, skills, templates, themes, and context files are disabled for the child. Styling follows Pi's CLI export defaults, not the live terminal theme. The initially displayed branch is selected from the persisted file, which can differ from the current in-memory selection after `/tree` navigation; all persisted branches remain included.

A success link is shown only after a zero, non-killed exit and a non-empty output file. Failures show diagnostics without dumping stdout or rerunning the export. The generated HTML contains conversation content and should be treated as private unless deliberately shared.

### `/md`

```text
/md <path-to-markdown-file>
```

Reads and renders a `.md` or `.markdown` file as a custom conversation message. Relative paths resolve from the current working directory, `~/` is expanded, and a whole quoted path is accepted. The command is read-only, but the rendered file content becomes part of the visible session transcript.

### `/roadmap`

```text
/roadmap <change request>
/roadmap --help
```

Requires readable `ROADMAP.md` in the current working directory. It launches an isolated non-interactive Pi process with only `read`, `edit`, and `write`, instructing it to update the roadmap and normally no other file. The child has no persisted session, context files, skills, templates, themes, or other extensions except usage tracking. The command can modify `ROADMAP.md` and has a ten-minute timeout.

The command reads structured completion events and compares the target's bytes before and after the run, including already-dirty files and non-Git directories. Only a zero exit plus valid settlement and a final normal `stop` confirms child completion. Confirmed runs with no content change are reported as no-ops rather than updates. A changed file with truncated, failed, aborted, missing, or malformed completion evidence produces a **warning** to review it before rerunning. Unreadable/deleted results are reported as unverified; unsuccessful runs with unchanged target bytes remain errors. Available response text and safe diagnostics are shown without dumping raw tool/context JSON.

The command never launches a second child or rolls back changes automatically; Pi's normal internal provider-retry behavior is unchanged. Snapshots and event output stay in memory, with no new retained transcripts or artifact paths. Byte changes do not validate the requested meaning or identify which process made concurrent edits; only `ROADMAP.md` is compared, so inspect any other explicitly requested files yourself.

## UI commands

### `/statusline`

```text
/statusline
/statusline debug
```

Without arguments, cycles `dracula → minimal → off → dracula`. The selection is in memory and resets with the extension process.

`debug` starts an in-memory trace of context-usage readings. Run it again to stop tracing and display up to the latest 100 samples. Traces contain event names, context token/percentage readings, and branch-entry counts; they are not persisted.

### `/statusline-colors`

```text
/statusline-colors
```

Toggles an above-editor preview of the colors used for unknown, low, medium, warm, limit, and high context percentages. The preview state is in memory only.

### `/response-time`

```text
/response-time
```

Toggles response-duration reporting, which starts enabled. While enabled, the footer status shows when the agent is responding and the duration of the last completed low-level agent run. The enabled state and timing history are in memory only.

## Maintaining this reference

When adding, removing, or changing a `pi.registerCommand(...)` surface under `extensions/`, update this Markdown source and regenerate `commands.html` in the same change. Source code remains authoritative when behavior and documentation disagree.
