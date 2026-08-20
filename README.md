# pise-en-place

Personal Pi extension package for Seth's workflow customizations. This repo is the source of truth for Pi safety checks, usage tracking, status UI, skill upkeep, context filtering, PR helpers, markdown output, local sharing, session todos, and roadmap maintenance.

## Install as a local Pi package

Install this repo instead of symlinking files into `~/.pi/agent/extensions`:

```bash
pi install /Users/sethfolley/Development/Personal/pise-en-place
```

Pi adds the local package path to `~/.pi/agent/settings.json` and loads the resources declared in `package.json` under the `pi` key.

For project-only use, install into project settings instead:

```bash
pi install -l /Users/sethfolley/Development/Personal/pise-en-place
```

After changing extension code in an active Pi session, run Pi's `/reload` command.

## What's included

### Safety

- `extensions/safety/index.ts` detects risky bash, edit, and write operations.
- Dangerous operations require confirmation before running.
- Risky bash commands can be blocked pending an agent-written explanation before the user retries.

### Usage and skill tracking

- `extensions/usage/index.ts` records assistant-response token usage and estimated cost in a private JSONL ledger.
- `/usage` reports by range, project, branch, model, provider, and skill usage, with JSON and visual report options.
- `extensions/skills/read-ledger.ts` tracks explicit skill command usage and skill-file reads without storing prompts or skill contents.
- See `docs/usage-tracking.md` and `docs/skill-read-tracking.md`.

### Skill upkeep

- `extensions/skills/update-agent-skills.ts` reads the skills manifest and checks pinned agent skills for newer tags at session start; each remote check times out after 10 seconds.
- `/update-skills --check` lists available updates.
- `/update-skills --interactive` lets the user choose updates, pins accepted refs, and syncs skills.
- `/update-skills` syncs skills through the shared shell scripts.

### Skill evaluation

- `/skill-eval` validates, starts, monitors, pauses, resumes, cancels, reports, and deletes durable skill-evaluation runs. A run opens its command-center monitor by default; pass `-b` to leave it in the background. The monitor shows live controller/cell process telemetry and selectable raw stdout/stderr for active agents; retained evidence stays redacted. Direct forms are listed by `/skill-eval help`.
- Milestone 1 runs isolated, headless Pi cells across no-skill, committed-baseline, and frozen-candidate arms; Codex, Claude Code, and the advisory supervisor remain deferred.
- Private event-sourced run state and compact redacted evidence live under `~/.pi/agent/skill-evals/`. Only one top-level evaluation runs globally.
- `skills/skill-eval-planner/` guides agents through creating reusable suites and release-specific comparisons; bundled templates and the authoring guide define the supported YAML.
- See the practical [HTML user guide](docs/skill-evaluation-user-guide.html) for setup, authoring, commands, monitoring, verdicts, and troubleshooting.
- See `docs/skill-evaluation-tool-design.md` for behavior, safety constraints, schemas, and milestone boundaries.

### UI helpers

- `extensions/ui/dracula-status-line.ts` adds the Dracula/minimal status line with branch, model, token, cost, context, and extension status details.
- `/statusline` cycles status line modes; `/statusline-colors` toggles context color examples.
- `extensions/ui/response-time.ts` tracks response timing; `/response-time` toggles reporting.
- `extensions/ui/interactive-agent-questions.ts` exposes the `ask_user` tool for guided TUI questions.

### Productivity helpers

- `extensions/productivity/current-pr.ts` adds `/pr` and the `get_current_branch_pr` tool for GitHub PR lookup via `gh`.
- `extensions/productivity/jira-worktree.ts` adds `/jira-worktree <JIRA-KEY>`: it reads the story through authenticated `acli`, uses an isolated no-tools Pi agent to propose concise branch slugs, presents them in an `ask_user`-style chooser with custom input, then immediately creates a Supacode worktree and starts Pi there with a concise ticket brief.
- `extensions/productivity/context.ts` adds `/context` status and `/context project config` for project-specific context-file and skill filtering, plus private project guidance injection.
- See `docs/private-guidance.md` for configuring per-project `additional_guidance` files.
- `extensions/productivity/todos.ts` adds `/todos`, the `todo` tool, and a session-scoped todo widget.
- `extensions/productivity/local-share.ts` adds `/share-local` for local HTML transcript export.
- `extensions/productivity/markdown-output.ts` adds `/md <path>` for rendering markdown file contents.
- `extensions/productivity/copy-session-id.ts` adds `alt+s` to copy the current session ID.
- `extensions/productivity/roadmap-writer.ts` adds `/roadmap <request>` to update `ROADMAP.md` through an isolated Pi process.

### Theme

- `themes/dracula-pro.json` registers the local Dracula Pro theme resources.

## Structure

```text
extensions/
  safety/          dangerous operation confirmations
  usage/           token/cost ledger and /usage command
  skills/          skill read tracking and skill update flows
  ui/              status line, response timing, ask_user UI tool
  productivity/    PR lookup, context filtering, local sharing, session helpers, todos, roadmap writer
src/shared/        shared implementation helpers used by extensions
skills/            agent workflows shipped by this package
themes/            Pi themes shipped by this package
docs/              design notes and user-facing docs
```

## Development

```bash
npm install
npm run typecheck
npm run test
npm run validate
```

## Runtime data

Runtime ledgers and local Pi files are intentionally not committed. Usage and skill-read ledgers are written under `~/.pi/agent/` by the relevant extensions.
