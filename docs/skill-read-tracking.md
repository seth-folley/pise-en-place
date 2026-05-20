# Pi Skill Read Tracking

`extensions/skill-read-ledger.ts` tracks when Pi skills are explicitly loaded or read. Reports are shown through `/usage skills` from `extensions/usage-ledger.ts`.

## What is tracked

The extension appends one JSONL record when either of these happens:

- A user invokes a skill command such as `/skill:swiftui-expert-skill`.
- The agent successfully uses the built-in `read` tool on a detected skill file, such as `SKILL.md`.

Records include timestamp, session identity, cwd, git-derived project metadata, skill name/path/scope/source, trigger type, and tool call id when available.

## What is not tracked

- Prompt text
- Skill file contents
- Assistant responses
- Historical sessions from before the extension was enabled
- Skill discovery at startup, unless a skill is later loaded/read

## Runtime ledger

Runtime data is stored outside this repo:

```text
~/.pi/agent/skill-reads/ledger.jsonl
```

## Entry schema

Each line in the JSONL ledger is one record with this shape:

```ts
type SkillReadRecord = {
  version: 1;
  id: string;
  timestamp: string; // ISO timestamp for when the skill read was observed
  recordedAt: string; // ISO timestamp for when the ledger entry was written
  trigger: "skill-command" | "read-tool";
  sessionFile: string | null;
  sessionId: string | null;
  cwd: string | null;

  project: {
    name: string | null;
    gitRemote: string | null;
    gitRoot: string | null;
    gitCommonDir: string | null;
  };

  skill: {
    name: string;
    path: string | null;
    scope: string | null;
    source: string | null;
  };

  toolCallId?: string; // present for read-tool records
};
```

`id` is a best-effort dedupe key built from session identity, trigger, skill name, and either the tool call id or timestamp.

## Commands

```text
/usage skills                        Show month-to-date skill usage counts
/usage skills today                  Show today's skill usage counts
/usage skills week                   Show current week skill usage counts
/usage skills month                  Show current month skill usage counts
/usage skills lifetime               Show all recorded skill usage counts
/usage skills --project <project>    Filter skill usage to one project
/usage skills --project              Group skill usage by project
/usage skills --json                 Emit machine-readable JSON
```

## Known limitations

- The read-tool detector records likely skill files. It matches known Pi skill command paths when available and otherwise recognizes `SKILL.md` or markdown files under common skill directories.
- Historical records captured before project metadata was added still appear in reports, grouped by `cwd` when git metadata is unavailable.
- Multiple Pi processes append to the same JSONL file without locking. If concurrent writes become a problem, migrate this ledger to SQLite.
- `/skill:name` records command invocation, while `read-tool` records actual file reads. A single task may create both records.
