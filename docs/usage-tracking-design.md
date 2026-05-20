# Pi Usage Tracking Design Notes

Temporary working doc for designing a personal Pi extension that tracks token usage and estimated spending across all sessions.

## Goal

Track Pi token usage and estimated cost across sessions, projects, models, and time periods.

The extension should answer questions like:

- How much did I spend today / this week / this month?
- Which projects use the most tokens?
- Which models/providers cost the most?
- How many input, output, cache read, and cache write tokens have I used?
- What token/cost usage has been recorded since tracking was enabled?

## Current Pi Behavior

Pi already stores per-assistant-message usage in session JSONL files under:

```text
~/.pi/agent/sessions/
```

Assistant messages include usage like:

```ts
usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

Pi's built-in footer and `/session` command show session-local usage/cost. This design is for cross-session tracking.

For this extension, we will store raw token counts plus only the total estimated cost. We will not store per-token-category cost breakdowns unless we later need them.

## Proposed Artifact

A Pi extension:

```text
extensions/usage/index.ts
```

Optional docs:

```text
docs/usage-tracking.md
```

Runtime data should not be committed.

## Runtime Ledger Location

Decision: store the runtime ledger globally under Pi's agent directory:

```text
~/.pi/agent/usage/ledger.jsonl
```

This tracks usage across all projects and sessions. The ledger is private runtime data and should not be committed to this repo.

## Storage Options

### Option A: JSONL Ledger

Path:

```text
~/.pi/agent/usage/ledger.jsonl
```

Pros:

- Simple append-only file
- Easy to inspect manually
- Easy to back up
- No database dependency

Cons:

- More work for queries/grouping
- Need explicit dedupe during rescan
- Large files may eventually be slower

### Option B: SQLite

Path:

```text
~/.pi/agent/usage/usage.sqlite
```

Pros:

- Better summaries and grouping
- Natural dedupe with unique keys
- Easier future dashboards/export

Cons:

- Adds dependency/complexity
- Slightly less transparent than JSONL

Decision: start with JSONL. If the ledger becomes too large or summaries become slow, migrate to SQLite instead of adding rollups.

## Ledger Record Shape

Draft JSONL record:

```ts
type UsageLedgerRecord = {
  version: 1;
  id: string; // stable dedupe id, probably `${sessionFile}:${entryId}`
  source: "live";
  timestamp: string; // ISO timestamp from assistant message/session entry
  recordedAt: string; // ISO timestamp when ledger was written

  sessionFile: string | null;
  sessionEntryId: string | null;
  cwd: string | null; // actual Pi cwd/worktree path for debugging

  project: {
    name: string | null;
    gitRemote: string | null; // normalized origin URL when available
    gitRoot: string | null; // current worktree root
    gitCommonDir: string | null; // shared .git dir across worktrees when available
  };

  provider: string | null;
  model: string | null;
  api: string | null;

  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    totalCost: number | null; // Pi-reported estimated USD total, or null when unavailable
  };
};
```

Decision: keep `cwd` as the actual Pi cwd/worktree path for debugging, but group reports by `project`, primarily derived from git metadata rather than individual worktree paths.

Project grouping preference:

1. Normalized `gitRemote`, if available
2. `gitCommonDir`, for local repos/worktrees without a remote
3. `gitRoot`, as a fallback
4. `cwd`, as a final fallback

This should avoid splitting usage across multiple worktrees for the same project.

## Capture Strategy

### Live Capture

Listen for finalized assistant messages:

```ts
pi.on("message_end", async (event, ctx) => {
  if (event.message.role !== "assistant") return;
  if (!event.message.usage) return;
  // append usage record
});
```

Need to confirm how to get stable session entry ID from `message_end`. If not available directly, use `agent_end` and/or inspect `ctx.sessionManager.getEntries()` after message finalization.

### Rescan/Reconcile

Decision: do not implement rescan for v1.

Tracking starts when the usage tracking extension is enabled. Historical sessions and historical forked/cloned messages are intentionally ignored.

## Commands

Draft command surface:

```text
/usage                          Show month-to-date summary
/usage today                    Show today's summary
/usage week                     Show current week summary
/usage month                    Show current month summary
/usage lifetime                 Show lifetime summary

/usage project --list           List recorded projects
/usage project <project>        Show lifetime usage for a specific project
/usage model --list             List recorded models
/usage model <model>            Show lifetime usage for a specific model
/usage clear                    Clear the usage ledger after confirmation
/usage clear --yes              Clear the usage ledger without confirmation
/usage -h                       Show command help
/usage --help                   Show command help
```

Every command supports `--json` to emit machine-readable output instead of human-readable text. Help supports `--json` too.

Time ranges supported by v1:

```text
today
week
month
lifetime
```

`/usage project` and `/usage model` are lifetime filter commands by default, not grouped report commands. Use `--list` to discover valid project/model values.

To inspect a project or model within a specific time range, use options on the time range commands:

```text
/usage today --project <project>
/usage week --project <project>
/usage month --project <project>
/usage lifetime --project <project>

/usage today --model <model>
/usage week --model <model>
/usage month --model <model>
/usage lifetime --model <model>
```

Possible future aliases:

```text
/spend
/tokens
```

## Budget Guard

Decision: do not include budget checks in v1.

Rationale: budget proximity will not change usage behavior, so warnings/blocks add complexity without much value.

Pi cannot automatically see provider/account budget limits anyway. The extension only knows costs recorded in this ledger.

Decision: subscription/OAuth-backed models may still have Pi-reported cost estimates. Record numeric `usage.cost.total` when present; use `usage.totalCost: null` only when no numeric estimate is available.

## Branching, Forking, and Deduplication

Important: Pi sessions can branch and fork. Abandoned branches still consumed tokens and cost money.

Each finalized assistant API response should be tracked in isolation as one spend event. Forking a session should not create new spend records for historical messages that already existed. Only new assistant responses after the fork should create new ledger records.

However, each new assistant response's provider-reported usage includes the input context sent for that specific call. In a fork, that input context may include historical conversation from before the fork. That is real new input-token usage for the new call, but it is not the same as re-counting the old assistant messages' previous costs.

Therefore the ledger should count every assistant API response that actually occurs after tracking is enabled, not only messages on the current active branch.

Because v1 does not rescan old session files, we do not need to dedupe copied historical entries across forked/cloned session files. We still keep a stable `id` for each live-captured response to avoid duplicate writes if an event handler retries.

Suggested live dedupe key:

```text
sessionFile + sessionEntryId
```

## Privacy / Git Ignore

Do not commit runtime usage data.

Recommended ignores:

```gitignore
.pi/usage/
usage.jsonl
usage.sqlite
```

## Decisions

- Store total estimated cost only, nested under `usage.totalCost`.
- Do not store per-category cost fields for input/output/cache read/cache write.
- Store Pi's reported `usage.cost.total` when it is numeric; otherwise set `usage.totalCost` to `null` and track tokens only.
- Do not store prompt text or session names in the ledger. Session identity is already represented by `sessionFile` and `sessionEntryId`.
- Commands render human-readable output by default and support `--json` for machine-readable output.
- Do not include budget checks in v1.

## Open Questions

None for v1.

## Development Plan

### Phase 1: Types and Pure Helpers

Create `extensions/usage/index.ts` with the core types and pure data-processing helpers first.

Helpers to implement:

- `parseUsageArgs(args: string): ParsedUsageCommand`
- `getRangeBounds(range: "today" | "week" | "month" | "lifetime", now = new Date())`
- `summarizeRecords(records, filters): UsageSummary`
- `listProjects(records): string[]`
- `listModels(records): string[]`
- `formatSummary(summary): string`
- `formatList(items): string`
- JSON output helpers for `--json`

Validation point:

- Use small inline fixture arrays to manually verify summary totals before wiring Pi events.
- Confirm `totalCost: null` records contribute to token totals but not dollar totals.

### Phase 2: Ledger File IO

Use Node's built-in `fs/promises`, `path`, and `os` modules. Avoid external dependencies.

Ledger path:

```text
~/.pi/agent/usage/ledger.jsonl
```

Functions:

- `ensureLedgerDir()` creates `~/.pi/agent/usage` recursively.
- `appendLedgerRecord(record)` appends one JSON line.
- `readLedgerRecords()` reads all JSONL records; missing file returns an empty array.
- Invalid/corrupt JSONL lines should be skipped and counted, not crash the command.

Data-writing decision:

- Write one complete JSON object per line with `appendFile`.
- Include a trailing newline for every record.
- No rollups or secondary cache in v1.
- No locking in v1; if concurrent Pi instances become an issue, migrate to SQLite.

Validation point:

- Test missing ledger file.
- Test appending two records and reading them back.
- Test one corrupt line is skipped and reported in command output or JSON metadata.

### Phase 3: Project Metadata

Implement `getProjectInfo(cwd)` using `git` commands via Node's `child_process.execFile` or `execFileSync`.

Commands:

```text
git rev-parse --show-toplevel
git rev-parse --git-common-dir
git remote get-url origin
```

Behavior:

- Run commands with the Pi `cwd`.
- Treat failures as `null`; non-git directories are valid.
- Normalize remote URLs so SSH/HTTPS variants group together where possible.
- Derive `project.name` from normalized remote repo name, then `gitRoot`, then `cwd`.

Validation point:

- Test in this repo.
- Test from a subdirectory.
- Test in a non-git temp directory.
- If practical, test from a git worktree and confirm grouping key is not just the worktree path.

### Phase 4: Live Capture

Register `message_end` handler:

```ts
pi.on("message_end", async (event, ctx) => {
  if (event.message.role !== "assistant") return;
  if (!event.message.usage) return;
  // build and append UsageLedgerRecord
});
```

Record-building decisions:

- `timestamp`: assistant message timestamp if available; otherwise current time.
- `recordedAt`: current time.
- `sessionFile`: `ctx.sessionManager.getSessionFile() ?? null`.
- `sessionEntryId`: find the matching latest assistant message entry from `ctx.sessionManager.getEntries()` if event does not expose the entry ID.
- `id`: `${sessionFile ?? "ephemeral"}:${sessionEntryId ?? timestamp}`.
- `usage.totalCost`: use `event.message.usage.cost.total` when it is numeric; set to `null` only when Pi does not provide a numeric estimate.

Validation point:

- Run Pi with the extension enabled and send one prompt.
- Confirm exactly one ledger line is appended.
- Confirm tool calls do not create extra ledger records except for additional assistant responses that actually have usage.
- Confirm `/fork` followed by a new prompt appends only the new assistant response.

### Phase 5: `/usage` Command

Register one command:

```ts
pi.registerCommand("usage", { ... })
```

Supported command forms:

```text
/usage
/usage today [--project <project>] [--model <model>] [--json]
/usage week [--project <project>] [--model <model>] [--json]
/usage month [--project <project>] [--model <model>] [--json]
/usage lifetime [--project <project>] [--model <model>] [--json]
/usage project --list [--json]
/usage project <project> [--json]
/usage model --list [--json]
/usage model <model> [--json]
```

Defaults:

- `/usage` is equivalent to `/usage month`.
- `/usage project <project>` is lifetime filtered by project.
- `/usage model <model>` is lifetime filtered by model.

Output decisions:

- Human-readable output by default via `ctx.ui.notify` or a custom message if multi-line output looks better.
- `--json` emits stable machine-readable JSON.
- Missing ledger file should report zero usage, not an error.
- Unknown project/model should show a helpful message and suggest `--list`.

Validation point:

- Verify every supported command form.
- Verify `--json` for every command class.
- Verify filters work with names that include slashes/colons from normalized remotes/models.

### Phase 6: Manual Test Checklist

Before considering v1 complete:

1. Start with no ledger file and run `/usage`.
2. Send one prompt and verify one ledger record.
3. Run `/usage today`, `/usage week`, `/usage month`, and `/usage lifetime`.
4. Run `/usage project --list` and `/usage model --list`.
5. Run filtered project/model commands.
6. Run time range commands with `--project` and `--model`.
7. Run a token-only scenario if available and verify cost is `null` and summaries separate token-only usage from dollar totals.
8. Confirm no prompt text or session name is written to the ledger.
9. Confirm runtime ledger remains outside this repo.

### Phase 7: Follow-up Documentation

After implementation, update or create:

```text
docs/usage-tracking.md
```

Include:

- What is tracked
- What is intentionally not tracked
- Ledger path
- Command reference
- Cost and token-only behavior
- Known limitations
