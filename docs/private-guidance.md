# Private Project Guidance

The context filter extension supports per-project private guidance files that are injected into the system prompt at agent startup. These files live outside your repository, so they are never committed.

## Configuration

Create `~/.pi/agent/projects.json` with a top-level object keyed by normalized Git remote ID:

```json
{
  "github.com:owner/repo": {
    "additional_guidance": "~/.pi/agent/project-guidance/owner-repo.md"
  }
}
```

### Project key format

The project key is a normalized Git remote origin URL, e.g. `github.com:owner/repo`. This is the same ID shown by the `/context` command.

### `additional_guidance` field

- **Type:** non-empty string
- **Value:** path to a private Markdown or instructions file
- `~` is expanded to your home directory
- Relative paths are not recommended; use absolute paths or `~`-prefixed paths

## Verification

Run `/context` to see the private guidance status. It shows one of:

- **Active:** the project key and resolved file path
- **Inactive:** no `additional_guidance` configured for this project
- **Error:** a validation or file-read error message

Private guidance is re-evaluated at the start of each new agent run, including automatic team wakeups on Pi 1.2. Edits to `projects.json` or the guidance file take effect on the next run. Tool follow-ups within an already-started run keep that run's injected guidance.

Automatic-wakeup integration is covered with synthetic projects and the real context extension in `tests/coordination/automation-sdk.test.ts`. Assertions inspect provider-boundary requests, prove per-project isolation and no duplicated guidance, and check that coordination does not automatically copy guidance into broker messages. This is not a guarantee that a model will never explicitly reproduce private instructions.

## Errors

If `projects.json` is malformed or the guidance file is missing, the error is reported in `/context` and shown via a notification at most once per distinct error per session.
