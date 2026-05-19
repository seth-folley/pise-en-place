# Roadmap

A lightweight place to track what has been added, what is next, and longer-term ideas for this Pi extension collection.

## Completed

### Project documentation and upkeep

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

### Supacode integration

- **Supacode integration** — Reports Pi agent busy state and completion notifications to Supacode-managed terminals.

## Todos

### Project documentation and upkeep

- **README overview** — Add setup instructions, extension list, and recommended Pi configuration.
- **Extension install guide** — Document how to enable individual extensions from this repo.
- **Manual test checklist** — Add repeatable checks for commands, hooks, and non-UI behavior.
- **Type import consistency** — Standardize Pi package imports across extensions.
- **Roadmap upkeep** — Update this file whenever features are added or priorities change.

### Safety: dangerous operation confirmations

- **Dangerous operation docs** — Document the allow, block, and explain flow with examples.
- **Protected path coverage** — Review and tune protected-path rules for edit/write operations.

### Usage tracking and reporting

- **Usage ledger validation** — Add fixture-based tests for parsing, filtering, summaries, and corrupt JSONL lines.

### Shared interaction components

- **Interactive questioning component** — Extract the interactive picker/question flow used by skill updates into a reusable component for commands that need guided user input.

### TUI and process display

- **Spawned Pi output pane** — Show output from newly spawned Pi instances in a smaller TUI window.

## Ideas

### Project documentation and upkeep

- **Configuration file** — Add shared configuration for enabled features, thresholds, and UI preferences.
- **Extension health command** — Add a command that reports enabled extensions, runtime paths, and recent errors.

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

### Skill updates and management

- **Project skill management** — Add a way to enable or disable project-local skills when new skills are added, without trying to version local skill contents.

### Tool output and build integration

- **Xcode build output handling** — Present `xcodebuild` results cleanly, either through a dedicated Pi build tool or by formatting invoked tool output.
