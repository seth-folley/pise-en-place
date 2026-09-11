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

See the complete command reference in [HTML](docs/commands.html) or its agent-friendly [Markdown source](docs/commands.md) for syntax, behavior, persistence, prerequisites, and side effects of every slash command provided by this package.

### Safety

- `extensions/safety/index.ts` detects risky bash, edit, and write operations.
- Dangerous operations require confirmation before running.
- A deliberately small, workspace-scoped read-only shell grammar (`find`, `rg`, read-only Git/GitHub queries, shell tests, and safe output piping) runs without confirmation; ambiguous syntax, external paths, and effectful commands remain gated.
- Optional portable home-directory roots can be added in `~/.pi/safety.json`; safety reads it for each permission check, it is never created automatically, and mutations remain gated:

  ```json
  { "version": 1, "readOnlyPaths": ["$HOME/.pi", "$HOME/Development"] }
  ```
- Risky bash commands can be blocked pending an agent-written explanation before the user retries.
- Each displayed safety dialog and its allow/block/explain decision is recorded as a private `pise-en-place:safety-dialog` entry in the Pi session JSONL for later inspection.

### Usage and skill tracking

- `extensions/usage/index.ts` records assistant-response token usage and estimated cost in a private JSONL ledger.
- `/usage` reports by range, project, branch, model, provider, and skill usage, with JSON and visual report options.
- `/usage openai` fetches the current OpenAI Codex subscription windows on demand without a persistent widget or background polling.
- `extensions/skills/read-ledger.ts` tracks explicit skill command usage and skill-file reads without storing prompts or skill contents.
- See `docs/usage-tracking.md` and `docs/skill-read-tracking.md`.

### Skill upkeep

- `extensions/skills/update-agent-skills.ts` reads the skills manifest and checks pinned agent skills for newer tags at session start; each remote check times out after 10 seconds.
- `/update-skills --check` lists available updates.
- `/update-skills --interactive` lets the user choose updates, pins accepted refs, and syncs skills.
- `/update-skills` syncs skills through the shared shell scripts.
- `/improve-skill <name-or-absolute-path>` opens a current-worktree Supacode tab with independent read-only Pi, Codex, and Claude reviews of the current skill contents. Use `--focus` to append review criteria, `--prompt <file.md>` to replace the built-in prompt, or `--show-prompt` to preview the exact composed prompts. Reviews remain visible for manual comparison and create no review artifacts.

### Skill evaluation

- `/skill:skill-eval-creator` guides agents through inspecting, proposing, confirming, and writing simplified eval YAML files without running them.
- `/skill-eval validate <eval.yaml>` strictly parses the skill-evaluation schema and checks the workspace and replacement source files.
- `/skill-eval run <eval.yaml>` executes variants sequentially in disposable Git workspaces with a full-screen monitor, retained Pi sessions/evidence, and Markdown/HTML reports.
- Stopped runs retain their exact failure phase, structured error chains/subprocess output, final lifecycle event, artifact completeness, and diagnostic hints in `failure.json`.
- An optional same-basename `<eval>.review.yaml` sidecar records reviewer-only objectives and expectations; it is validated and retained but never submitted to the evaluated agent.
- `/skill-eval review <run-id|path|latest>` resolves settled retained evidence and dispatches `/skill:skill-eval-reviewer` in the current session.
- The reviewer applies a common ordinal rubric and writes validated `review.json` plus deterministic `review.html` under the run's versioned `reviews/` directory.
- Validation does not inspect replacement targets, Git state, models, tools, symlinks, or project contents.
- See `docs/skill-evaluation.md` for usage and `docs/skill-evaluation-implementation-plan.md` for the detailed evidence and monitor contract.

### UI helpers

- `extensions/ui/dracula-status-line.ts` adds the Dracula/minimal status line with branch, model, token, cost, context, and extension status details. A `~` context percentage is a retained estimate used while Codex tool-use usage metadata is incomplete; after compaction it shows `--%` until Pi reports reliable post-compaction usage.
- `/statusline` cycles status line modes; `/statusline-colors` toggles context color examples. `/statusline debug` toggles an in-memory trace of Pi context-usage readings and shows the samples when disabled.
- `extensions/ui/response-time.ts` tracks response timing; `/response-time` toggles reporting.
- `extensions/ui/interactive-agent-questions.ts` exposes the `ask_user` tool for guided TUI questions.
- Safety permission prompts and `ask_user` questions send a rich attention notification to their originating Supacode surface; the notifier respects Supacode's notification settings and is inert in other terminals.

### Subagent orchestration

- `extensions/orchestration/subagent/` gives the main agent a `subagent` tool for isolated **scout**, **researcher**, and **reviewer** work. It supports one task or independent parallel tasks (up to 8 tasks, 4 at once); package-owned definitions keep role behavior consistent.
- Subagents are read-only by default. The reviewer can use Bash only for read-only Git inspection. The tool row shows a compact parallel/completion summary and expands to each role's exact task and status. While active, an above-editor activity tray shows each role, live tool activity, and completion/failure state; it remains visible until the parent agent finishes its turn.
- Each subagent also saves an isolated native Pi session under `~/.pi/agent/subagent-sessions/<parent-session-id>/`. Run `/subagents` in the parent session to list retained children and copy the `pi --session-dir … --session …` command needed to inspect one. Child sessions are linked to the parent without adding their full transcripts to the parent context. Their usage session inherits the parent's active usage tags and adds `subagent` plus `subagent-<role>`.
- Configure defaults and per-role model/thinking overrides in global `~/.pi/agent/settings.json` and optional project `.pi/settings.json`; project values override global values:

  ```json
  {
    "subagents": {
      "defaults": { "model": "openai-codex/gpt-5.4", "thinking": "medium" },
      "agents": { "scout": { "model": "openai-codex/gpt-5.4-mini", "thinking": "low" } }
    }
  }
  ```

### Agent coordination (autonomous communication)

- `extensions/coordination/index.ts` adds `/team` (including local-ID completion and an explicit dashboard), `team_status`, `team_send`, `team_read`, and a persistent team widget.
- An automatically managed local Unix-socket broker owns SQLite-backed rooms, messages, inboxes, presence, and delivery recovery. Multiple isolated teams can run concurrently; the pilot joins one room per Pi session.
- Reload Pi, then `/team join <room> --name <name> --role worker`. Joining starts/reuses the broker automatically; it shuts down after 60 seconds without connections. No normal setup/teardown commands.
- Eligible messages automatically wake idle recipients or wait for busy agents to settle. Questions, requested replies, decision requests, and actionable handoffs are eligible; informational traffic never wakes agents.
- Durable limits: 100 activations/room/rolling hour with no lifetime thread cap, with batching, pause-on-abort, and conservative uncertain-delivery recovery. No spawning or moderator/decision approval tools. Requires Node 24.15+ and Pi 0.85.1+ on macOS/Linux.
- See [setup, commands, privacy, recovery, and live smoke test](docs/agent-coordination.md) and [protocol v1](docs/agent-coordination-protocol.md).

### Productivity helpers

- `extensions/productivity/current-pr.ts` adds `/pr` and the `get_current_branch_pr` tool for GitHub PR lookup via `gh`.
- `extensions/productivity/jira-worktree.ts` adds `/jira-worktree <JIRA-KEY>`: it reads the story through authenticated `acli`, uses an isolated no-tools Pi agent to propose concise branch slugs, presents them in an `ask_user`-style chooser with custom input, then immediately creates a Supacode worktree and starts Pi there with a concise ticket brief.
- `extensions/productivity/context.ts` adds `/context` status and `/context project config` for project-specific context-file and skill filtering, plus private project guidance injection.
- See `docs/private-guidance.md` for configuring per-project `additional_guidance` files.
- `extensions/productivity/todos.ts` adds `/todos`, the `todo` tool, and a session-scoped todo widget.
- `extensions/productivity/local-share.ts` adds `/share-local` for local HTML transcript export.
- `extensions/productivity/markdown-output.ts` adds `/md <path>` for rendering markdown file contents.
- `extensions/productivity/copy-session-id.ts` adds `alt+s` to copy the current session ID.
- `extensions/productivity/cut-input.ts` adds `ctrl+shift+x` to cut the current input and `alt+/` to copy it (when present) and begin a slash command.
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
  coordination/    explicit team enrollment, automatic messaging, inbox/status widget
src/coordination/  local SQLite broker, socket protocol/client, delivery adapter
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

Runtime ledgers and local Pi files are intentionally not committed. Usage and skill-read ledgers are written under `~/.pi/agent/` by the relevant extensions. The coordination broker stores its private database, socket, and control credential under `<Pi user directory>/coordination/`; see the coordination guide before backup, cleanup, or deletion.
