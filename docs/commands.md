# Command reference

This document lists the slash commands provided by `pise-en-place`. It does not include Pi's built-in commands or package tools invoked by the model. Run a command without required arguments, or with `--help` where supported, for inline guidance.

After changing or installing extensions, run Pi's built-in `/reload` command.

## Quick reference

| Command | Purpose |
| --- | --- |
| [`/usage`](#usage) | Usage ledger reports, Codex subscription limits, session tags, and skill-read reports |
| [`/update-skills`](#update-skills) | Check, select, and install agent skill updates |
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

## Usage and skills

### `/usage`

Tracks finalized assistant-response metadata in `~/.pi/agent/usage/ledger.jsonl` and reports it without storing prompt or response content.

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

Reports group usage by provider, model, and project and show the most expensive recorded responses. `--visual` produces terminal-friendly horizontal graphs and cannot be combined with `--json`.

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

### `/update-skills`

```text
/update-skills
/update-skills --check
/update-skills --interactive
/update-skills --respect-interval
```

Aliases `check`/`-c` and `interactive`/`-i` are accepted.

- No option: runs the local skill sync script with `--force`.
- `--respect-interval`: runs the sync script without forcing its configured interval.
- `--check`: checks version-pinned manifest sources for newer refs without installing them.
- `--interactive`: requires interactive UI, opens a selector, updates accepted manifest refs, and syncs the selected changes.

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

Membership entries and inspection/delivery evidence are durable, and the broker retains room history and receipts. Automatic membership restoration currently occurs only during `/reload`; ordinary new/resume/fork startup does not auto-enroll, so explicitly rejoin when needed. The private broker database, socket, and credentials live under the Pi user directory. Human control operations require interactive TUI confirmation. Coordination requires Node 24.15+, Pi 0.85.1+, and macOS or Linux. See [agent coordination](agent-coordination.md) and the [coordination protocol](agent-coordination-protocol.md).

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
/jira-worktree <JIRA-KEY>
```

Requires interactive UI, a selected model, a Git repository, authenticated `acli`, `supacode`, and `pi` executables.

1. Reads the Jira item and repository root.
2. Runs an isolated, no-tools Pi process to suggest concise branch slugs.
3. Lets the user select or enter a slug.
4. Creates a Supacode worktree using the package's branch convention.
5. Opens a new Supacode tab with Pi started on the Jira context.

This command creates a Git worktree and starts another Pi session.

### `/share-local`

```text
/share-local [output-path]
```

Waits for the agent to become idle, exports the complete file-backed session to HTML, and prints an openable local link. A relative path is resolved from the current working directory; `.html` is added when omitted. Without a path, output goes under `~/.pi/agent/sessions/transcripts/` (or the configured Pi agent directory). In-memory sessions cannot be exported.

The generated HTML contains conversation content and should be treated as private unless deliberately shared.

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

Requires `ROADMAP.md` in the current working directory. It launches an isolated non-interactive Pi process with only `read`, `edit`, and `write`, instructing it to update the roadmap and normally no other file. The child has no session, context files, skills, templates, themes, or other extensions except usage tracking. The command can modify `ROADMAP.md` and has a ten-minute timeout.

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
