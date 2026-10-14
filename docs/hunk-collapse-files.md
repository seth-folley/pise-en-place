# Hunk file collapse

`extensions/hunk/collapse-files.ts` is a **Hunk extension**, not a Pi extension.
It targets Hunk 0.23.0's public file-view API. Nothing is installed globally,
registered with Pi, or written to Hunk's config automatically.

## Try it

From this repository:

```bash
hunk diff --extension ./extensions/hunk/collapse-files.ts
```

To review another repository, use the absolute extension path from that checkout:

```bash
hunk diff --extension /Users/sethfolley/Development/Personal/pise-en-place/extensions/hunk/collapse-files.ts
```

Select a file and press **Z** (Shift+Z), or choose **Extensions → Toggle file
collapse**. The file's normal header and files-pane entry remain; its diff body
becomes one summary row with hunk count and addition/deletion totals. Press Z
again to restore Hunk's raw diff. Lowercase `z` retains Hunk's built-in context
expansion behavior.

Files start expanded. Hunk owns the per-file presentation choices in memory;
there is no extension-owned ledger or persistent collapse state. Hunk may retain
presentation choices for unchanged files across a review reload. Expanding
returns to **raw diff**, not a previously selected alternate file view.

The view is also available as **Collapsed file** in Hunk's View menu. No
extra keyboard mode is activated, and ordinary file/hunk navigation stays
host-owned. With no selected file (for example, an empty file filter), the
command shows “No file selected” and does nothing.

## Load globally from this repo

Add the directory to `~/.config/hunk/config.toml` (append it if an
`[extensions].paths` list already exists):

```toml
[extensions]
paths = ["/Users/sethfolley/Development/Personal/pise-en-place/extensions/hunk"]
```

Normal `hunk diff` now loads the extension without `--extension`. The source
stays in this repo; edits and additional extensions in this directory take
effect when Hunk restarts. Hunk discovers top-level extension entry files and
folder extensions. Keep this directory Hunk-only rather than pointing at the
parent `extensions/` directory containing Pi extensions.

This user config is outside Git and is not installed by the Pi package.

## Limitations

- **Inline notes remain visible.** The summary has no source-line bindings, so
  Hunk falls back to the full raw diff when visible notes cannot be placed in
  this view. Hide the note layer with Hunk's normal controls to see the collapsed
  presentation. Active draft editing can also require raw diff.
- This is a compact alternate file view, not native clickable header folding.
  All hunks map to the same summary row; navigating to a hunk does not
  automatically expand the file. Expand with Z before inspecting source lines.
- Hunk handles wrapping/clipping at narrow widths and resolves the command's
  shortcut. A conflicting user binding may take Z, but the Extensions-menu
  action remains available.

To remap it yourself, add to your Hunk user config (not the repo config):

```toml
[keybindings]
"collapse-files.toggle" = "x"
```

## Validation

```bash
npm run validate
```

`hunkdiff` is a development-only dependency supplying the official types; the
extension's import is type-only and it needs no npm dependencies at runtime.
A scoped `shell-quote` override avoids the vulnerable version pinned by that
Hunk package. Its optional CLI/peer dependencies are not used by this extension.

Tests cover registration, summary layouts, complete hunk mappings, no source
reads or file mutations, zero-hunk files, partial statistics, toggle dispatch,
and an empty selection. They do not run Hunk's renderer. Manually check two
files independently, multi-hunk and binary files, inline notes, a narrow terminal,
and toggling via both Z and the Extensions menu in your terminal.
