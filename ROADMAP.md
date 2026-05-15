# Roadmap

A lightweight place to track what has been added, what is next, and longer-term ideas for this Pi extension collection.

## Completed

- **Dangerous operation confirmations** — Detects risky bash, edit, and write operations and asks before allowing them.
- **Dangerous command explanations** — Lets the user ask the agent to explain a risky bash command before retrying it.
- **Dracula status line** — Adds a themed footer with branch, model, token, cost, and context-window details.
- **Response time status** — Shows when the agent is responding and records the last response duration.
- **Local transcript sharing** — Exports the current Pi session to a local HTML transcript with an openable file link.
- **Usage ledger** — Tracks cross-session token usage and estimated cost in a private JSONL ledger.
- **Usage reporting command** — Adds `/usage` summaries by time range, project, and model, with JSON output support.
- **Skill update command** — Adds startup skill update checks and `/update-skills` flows, including an interactive picker.
- **Supacode integration** — Reports Pi agent busy state and completion notifications to Supacode-managed terminals.
- **Runtime file ignores** — Keeps local Pi sessions, usage ledgers, build output, logs, and secrets out of git.

## Todos

- **README overview** — Add setup instructions, extension list, and recommended Pi configuration.
- **Extension install guide** — Document how to enable individual extensions from this repo.
- **Manual test checklist** — Add repeatable checks for commands, hooks, and non-UI behavior.
- **Usage ledger validation** — Add fixture-based tests for parsing, filtering, summaries, and corrupt JSONL lines.
- **Dangerous operation docs** — Document the allow, block, and explain flow with examples.
- **Protected path coverage** — Review and tune protected-path rules for edit/write operations.
- **Type import consistency** — Standardize Pi package imports across extensions.
- **Roadmap upkeep** — Update this file whenever features are added or priorities change.

## Ideas

- **SQLite usage backend** — Migrate the usage ledger to SQLite if JSONL summaries become slow or concurrent writes matter.
- **Budget alerts** — Add optional warning thresholds for recorded monthly usage or estimated cost.
- **Historical usage import** — Add an opt-in command to backfill usage from existing session files.
- **Dangerous edit explanations** — Extend the explain flow to protected edit/write operations.
- **Configuration file** — Add shared configuration for enabled features, thresholds, and UI preferences.
- **Extension health command** — Add a command that reports enabled extensions, runtime paths, and recent errors.
- **Exported usage reports** — Support CSV or Markdown exports for usage summaries.
- **More status line themes** — Add additional status line styles beyond Dracula and minimal.
