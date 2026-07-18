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

Private guidance is re-evaluated on every agent turn, so edits to `projects.json` or the guidance file take effect on the next agent turn.

## Errors

If `projects.json` is malformed or the guidance file is missing, the error is reported in `/context` and shown via a notification at most once per distinct error per session.
