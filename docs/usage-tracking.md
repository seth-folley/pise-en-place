# Usage Ledger Extension

`extensions/usage/index.ts` tracks Pi token usage and estimated spending across sessions.

## What it records

The extension records one ledger entry for each finalized assistant response after the extension is enabled.

Each record includes:

- timestamp and recorded time
- session file and session entry ID
- current working directory
- git-derived project metadata, including the local git branch when available
- active session usage tags, when set
- provider, model, and API
- provider-reported usage/cost surfaced through Pi for each response
- input, output, cache read, and cache write tokens
- total tokens
- total estimated cost, when meaningful

It does **not** record:

- prompt text
- assistant response text
- session names
- historical sessions from before the extension was enabled
- budget limits or budget warnings

## Ledger location

Runtime data is written to:

```text
~/.pi/agent/usage/ledger.jsonl
```

This file is private runtime data and should not be committed.

## Cost and subscription models

The extension stores Pi's reported `usage.cost.total` when Pi provides a numeric estimate.

If Pi does not provide a numeric cost estimate, the extension still records token counts and stores:

```ts
usage.totalCost = null
```

This keeps token usage visible without inventing a spend amount. Some OAuth/subscription-backed providers still expose estimated or extra-usage costs in Pi; those costs are recorded.

## Project and branch grouping

The extension keeps the actual Pi `cwd` for debugging, but project reports are grouped with git metadata.

Project grouping priority:

1. normalized git remote URL
2. git common directory
3. git worktree root
4. current working directory

This avoids splitting usage across multiple git worktrees for the same project when possible.

Branch tracking stores the local git branch name from `git branch --show-current`. Detached HEADs, non-git directories, and older records without branch metadata are grouped as `untracked` in project branch reports.

### Local attribution override

A workspace may override the project identity and/or branch for newly recorded usage with `.pi/usage.json`:

```json
{
  "version": 1,
  "project": {
    "gitRemote": "github.com/sethfolley/pise-en-place",
    "gitBranch": "feature/usage-attribution"
  },
  "tags": ["ios", "feature-work"]
}
```

Both `project.gitRemote` and `project.gitBranch` are optional. `gitRemote` is normalized and used as the normal project grouping key; the display name continues to be derived from it. Omitted values retain the Git-derived value. `tags` is an optional array of non-empty default tags. Defaults are combined with active session tags. The config affects only new ledger records and does not change the working directory or local Git metadata recorded with them.

## OpenAI Codex subscription limits

When Pi has an `openai-codex` OAuth login, the usage extension can fetch the account's current subscription limits on demand:

```text
/usage openai
/usage openai --json
```

Each invocation makes a fresh request and displays every available rolling window, percentage used, time until reset, plan type, and any model-specific additional limits returned by OpenAI. There is no persistent widget, startup request, post-response polling, or result cache.

The extension reuses Pi's managed OpenAI OAuth access token in memory and does not store or log credentials, raw responses, or limit readings. This integration calls OpenAI's undocumented `https://chatgpt.com/backend-api/wham/usage` endpoint, so schema or availability may change; failures are shown as unavailable rather than as zero usage.

## Commands

Default month-to-date summary:

```text
/usage
```

Time ranges:

```text
/usage today
/usage week
/usage month
/usage lifetime
```

Spend reports:

```text
/usage report
/usage report today
/usage report week
/usage report month
/usage report lifetime
/usage report --project <project>
/usage report --model <model>
/usage report --visual
```

`/usage report` defaults to month-to-date and groups spend by provider, model, and project. It also lists the top costed assistant responses without storing prompt or response content.

`/usage report --visual` renders a static terminal-friendly usage graph with horizontal bars for project, provider, and model spend. It can be combined with range and filter options, but not with `--json`.

Projects:

```text
/usage project --list
/usage project <project>
/usage project <project> --branch
/usage project <project> --branch <branch>
```

`/usage project <project>` shows a lifetime project report with overview, branch, and tag breakdowns when tagged records exist. Branch names are local to a project; use `--branch` with no value to filter to the current Git branch, or `--branch <branch>` to filter directly. Project- or branch-filtered summaries and reports also include available tag breakdowns. A record with multiple tags contributes to each of its tag rows, so tag totals may overlap rather than sum to the report total.

Models:

```text
/usage model --list
/usage model <model>
```

Skills:

```text
/usage skills
/usage skills today
/usage skills week
/usage skills month
/usage skills lifetime
/usage skills --project <project>
/usage skills --project
```

`/usage skills --project <project>` filters skill usage to one project. `/usage skills --project` with no value groups skill usage by project.

Clear the ledger:

```text
/usage clear
/usage clear --yes
```

`/usage clear` asks for confirmation when UI is available. Use `--yes` for non-interactive contexts.

Filter time ranges:

```text
/usage month --project <project>
/usage today --model <model>
/usage lifetime --project <project> --model <model>
/usage month --branch
/usage month --project <project> --branch <branch>
```

`--branch <branch>` requires a project because local branch names may repeat across repositories. With no value, `--branch` defaults to the current workspace's Git project and branch. Detached HEADs and non-Git directories must supply an explicit branch.

### Session tags

Tags are arbitrary, session-scoped labels attached to every later usage record. At session start, Pi snapshots the session identity, workspace/project attribution, branch, and `.pi/usage.json` default tags into a private `usage-session` entry. `/usage tag` changes only that snapshot's mutable tags; later config or Git changes do not alter records already attributed to the session. Tags are additive and persist in the current session branch.

```text
/usage tag implementation,usage-attribution
/usage tag --remove implementation
/usage tag --clear
/usage tag --list
```

Use quotes for a tag containing spaces, for example `/usage tag "PR review"`. Commas separate tags. Adding a tag already in the active list has no effect. Tags affect only subsequent records; they do not change historical ledger entries.

Help:

```text
/usage -h
/usage --help
```

Machine-readable output:

```text
/usage --json
/usage report --json
/usage report month --project <project> --json
/usage report --visual
/usage project --list --json
/usage month --project <project> --json
/usage project <project> --json
/usage month --project <project> --branch <branch> --json
/usage skills --json
/usage skills --project --json
/usage tag --list --json
/usage -h --json
```

## Notes and limitations

- Tracking starts only after the extension is enabled.
- There is no rescan of older session files in v1.
- Ledger reports use Pi's provider-reported per-response usage/cost. `/usage openai` is the exception: it reads current subscription windows from OpenAI and does not add them to the ledger.
- Summaries are derived from raw JSONL records on demand.
- If the ledger becomes too large or concurrent writes become a problem, migrate to SQLite rather than adding rollups.
- Corrupt JSONL lines are skipped and counted instead of crashing commands.
