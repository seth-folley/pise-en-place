# Roadmap

A lightweight place to track what has been added, what is next, and longer-term ideas for this Pi extension collection.

## Completed

### Project documentation and upkeep

- **Local Pi package structure** — Declares this repo as a Pi package, groups extensions by domain, and documents local package installation instead of symlinking global extensions.
- **Runtime file ignores** — Keeps local Pi sessions, usage ledgers, build output, logs, and secrets out of git.
- **Roadmap writer command** — Adds `/roadmap` to delegate ROADMAP.md edits to an isolated non-interactive Pi process without adding child reasoning to the current context, while still recording usage.

### Safety: dangerous operation confirmations

- **Dangerous operation confirmations** — Detects risky bash, edit, and write operations and asks before allowing them.
- **Dangerous command explanations** — Lets the user ask the agent to explain a risky bash command before retrying it.

### Usage tracking and reporting

- **Usage ledger** — Tracks cross-session token usage and estimated cost in a private JSONL ledger.
- **Usage reporting command** — Adds `/usage` summaries by time range, project, and model, with JSON output support.

### Status line and response feedback

- **Dracula status line** — Adds a themed footer with branch, model, token, cost, and context-window details.
- **Response time status** — Shows when the agent is responding and records the last response duration.

### Local transcript sharing

- **Local transcript sharing** — Exports the current Pi session to a local HTML transcript with an openable file link.

### Skill updates

- **Skill update command** — Adds startup skill update checks and `/update-skills` flows, including an interactive picker.

### Shared interaction components

- **Interactive questioning component** — Extracts the tabbed question flow into a reusable component and exposes `ask_user` so agents can ask one or many guided interactive questions, including optional custom answers.

### Session todo list

- **Session todo widget and tool** — Adds a branch-aware session todo list shared by the user and agent, with a `todo` agent tool, `/todos` management command, and an above-editor TUI widget that hides when empty and can be toggled with `/todos`.

### Context file filtering

- **Context status and filtering base** — Adds `/context` status reporting and per-Git-project context-file filtering from Pi settings, while always preserving global `~/.pi/agent/AGENTS.md`. Current implementation filters by removing matching `<project_instructions>` blocks from the assembled system prompt on each agent run because normal Pi extensions cannot mutate the loaded context-file list.

## Todos

### Project documentation and upkeep

- **Extension install guide** — Document how to enable individual extensions from this repo.
- **Manual test checklist** — Add repeatable checks for commands, hooks, and non-UI behavior.
- **Type import consistency** — Standardize Pi package imports across extensions.
- **Extension smoke tests** — Add tests that import/register extensions against a mocked Pi API to catch load and registration failures.
- **Interactive question tests** — Add Vitest coverage for `ask_user` schema normalization and edge cases such as cancellation, multi-select, empty options with `allowOther`, and custom text.
- **Roadmap upkeep** — Update this file whenever features are added or priorities change.

### Safety: dangerous operation confirmations

- **Dangerous operation docs** — Document the allow, block, and explain flow with examples.
- **Protected path coverage** — Review and tune protected-path rules for edit/write operations.

### Usage tracking and reporting

- **Usage ledger validation** — Add fixture-based tests for parsing, filtering, summaries, and corrupt JSONL lines.

### TUI and process display

- **Spawned Pi output pane** — Show output from newly spawned Pi instances in a smaller TUI window.
- **Sidebar scratch chat** — Add an extension for a temporary sidebar chat with Pi while the main agent/process is running, intended for one-off questions and brief side conversations that do not enter the main agent context.

### Session todo list

- **Todo command naming cleanup** — Revisit whether the user-facing command should be `/todo` instead of `/todos`, and add compatibility aliases if helpful.
- **Todo manual tests** — Add a checklist or smoke tests covering agent tool mutations, user command mutations, widget show/hide behavior, reload reconstruction, and session tree navigation.

## Ideas

### Project documentation and upkeep

- **Configuration file** — Add shared configuration for enabled features, thresholds, and UI preferences.
- **Extension health command** — Add a command that reports enabled extensions, runtime paths, and recent errors.

### Context file filtering

- **Runtime context reinjection** — Revisit commands for including ignored context files mid-session, such as `/context include`, `/context ignore`, or `/context include-once`.
- **Load-time context filtering** — Revisit an SDK wrapper or Pi core hook that filters `AGENTS.md`/`CLAUDE.md` before Pi records them as loaded, avoiding prompt-string surgery and startup-header mismatch.

### Safety: dangerous operation confirmations

- **Dangerous edit explanations** — Extend the explain flow to protected edit/write operations.

### Usage tracking and reporting

- **SQLite usage backend** — Migrate the usage ledger to SQLite if JSONL summaries become slow or concurrent writes matter.
- **Budget alerts** — Add optional warning thresholds for recorded monthly usage or estimated cost.
- **Skill usage tracking** — Track which agent skills are used during sessions and include them in usage reports.
- **Historical usage import** — Add an opt-in command to backfill usage from existing session files.
- **Exported usage reports** — Support CSV or Markdown exports for usage summaries.

### Status line and response feedback

- **More status line themes** — Add additional status line styles beyond Dracula and minimal.

### Session todo list

- **Project-scoped todos** — Add optional project-level todos stored outside the session for tasks that should survive across Pi sessions.
- **Hybrid pinned todos** — Support session todos plus durable pinned/project todos in one widget.
- **Interactive todo panel** — Add a focused `/todos` panel or overlay with keyboard navigation for toggling, editing, deleting, and adding items.
- **Todo visibility persistence** — Optionally remember widget visibility globally or in the session instead of resetting on reload.
- **Todo rendering polish** — Replace dim notification output with a brighter custom-rendered message or panel for `/todos list` and help output.

### Skill updates and management

- **Project skill management** — Add a way to enable or disable project-local skills when new skills are added, without trying to version local skill contents.

### Tool output and build integration

- **Xcode build output handling** — Present `xcodebuild` results cleanly, either through a dedicated Pi build tool or by formatting invoked tool output.
