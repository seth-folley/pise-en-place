# Usage Ledger Extension

`extensions/usage-ledger.ts` tracks Pi token usage and estimated spending across sessions.

## What it records

The extension records one ledger entry for each finalized assistant response after the extension is enabled.

Each record includes:

- timestamp and recorded time
- session file and session entry ID
- current working directory
- git-derived project metadata
- provider, model, and API
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

## Project grouping

The extension keeps the actual Pi `cwd` for debugging, but project reports are grouped with git metadata.

Grouping priority:

1. normalized git remote URL
2. git common directory
3. git worktree root
4. current working directory

This avoids splitting usage across multiple git worktrees for the same project when possible.

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

Projects:

```text
/usage project --list
/usage project <project>
```

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
```

Help:

```text
/usage -h
/usage --help
```

Machine-readable output:

```text
/usage --json
/usage project --list --json
/usage month --project <project> --json
/usage skills --json
/usage skills --project --json
/usage -h --json
```

## Notes and limitations

- Tracking starts only after the extension is enabled.
- There is no rescan of older session files in v1.
- Summaries are derived from raw JSONL records on demand.
- If the ledger becomes too large or concurrent writes become a problem, migrate to SQLite rather than adding rollups.
- Corrupt JSONL lines are skipped and counted instead of crashing commands.
