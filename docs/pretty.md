# Pretty output

`extensions/ui/pretty/index.ts` provides session-only controls for package-owned tool-output formatters. It changes presentation, not tool execution, permissions, model-facing content, stored results, or MCP configuration. It neither starts servers nor queries Xcode.

## Commands

```text
/pretty                         # Show formatter preferences
/pretty list                    # List all formatter names, descriptions, and on/off states
/pretty xcode-build on|off       # BuildProject
/pretty xcode-log on|off         # GetBuildLog
/pretty xcode-issues on|off      # XcodeRefreshCodeIssuesInFile
/pretty xcode on|off             # All Xcode formatters
/pretty on|off                   # All registered package formatters
/pretty --help
```

`/pretty list` and bare `/pretty` list every registered package formatter, its brief description, and current on/off preference without changing state. Tab completion suggests `list`, formatter/group names, and actions. Unknown names/actions show usage without changing preferences. All formatters start enabled. Preferences are in memory only and reset on `/reload`, process restart, or `session_start` (including new/resumed sessions); no settings, entries, or ledger files are written. Switching the transcript branch alone does not reset preferences.

Toggles redraw already constructed tool rows as well as affecting future calls. Disabling delegates to the original renderer, or Pi's generic fallback when none is available. It does not change expansion state. Weak redraw references do not retain closed transcript rows. This is not a global switch for Pi's built-in views, subagent UI, or other packages' formatters.

## Xcode views

The initial formatters target the exact tool names `mcp__xcode__BuildProject`, `mcp__xcode__GetBuildLog`, and `mcp__xcode__XcodeRefreshCodeIssuesInFile`. Different server aliases are not matched automatically. The resolver works before a tool is registered, so a resumed transcript does not need an Xcode connection to render.

- Collapsed views show explicit producer-reported outcome text, counts of **returned entries only**, and up to three error entries. Filtered/paginated logs do not imply whole-build totals. Refresh success is explicitly not build success.
- Pi's existing tool expansion action (normally Ctrl+E or click in fullscreen mode) reveals all recognized diagnostics and the available raw response, including unrecognized extra fields. Expanded arguments use the original call renderer. Existing full-output file pointers remain visible.
- The standard Pi tool shell owns padding, wrapping, expansion, and images. Other extensions' `renderShell: "self"` renderers take precedence rather than changing their framing contract. `/pretty` reports preferences, not a guarantee that a particular payload can be prettified.
- Partial/progress, transport-error, mixed-block, image, malformed, oversized, ambiguous, and unknown result formats delegate to the original result view. The compact call label may still identify the selected Xcode tool; unknown data is not silently converted to success or discarded.
- Terminal control sequences are removed from the formatter's own displayed labels/messages; original results are never mutated. Theme colors are applied on every render, not cached in parsed data.

### Conservative shape recognition

Apple's inspected static Xcode resources establish tool names/semantics but do not publish these result schemas. Recognition is intentionally narrow, not a declaration of an authoritative Apple wire contract:

- Build results: a JSON object with nonempty string `buildResult` and an `errors` array, optionally a `warnings` array. Entries are nonempty message strings or objects with a nonempty `message`. Conflicting severity labels in named arrays cause raw fallback. `buildResult` is displayed verbatim with neutral styling; no success inference from prose.
- Build logs: a JSON object with `buildLogEntries`. Diagnostic objects carry `message` and optional supported string `category`/`severity`, `path`/`filePath`, and positive integer `lineNumber`/`line`. True boolean `buildIsRunning` and `hasMore` flags are called out. False or absent flags produce no completion or full-results claim. Conflicting location/severity aliases cause raw fallback.
- File diagnostics: a JSON object with boolean `success` and a `diagnostics` array. A successful refresh does not assert the file/project compiles. Unsupported/conflicting severity representations cause raw fallback.

Only single text-block JSON responses up to 1,000,000 characters are recognized. The TUI renderer receives `content`/`details`, not the complete MCP `structuredContent` envelope; it does not assume that envelope is available or read full-output files during rendering. Source text, parsed summaries, and redraw handles remain attached to their existing tool rows, not external storage.

These formatters apply to individually rendered tool rows. Nested Xcode calls inside codemode remain part of codemode's own output; their result payloads are not separate persisted tool rows. No codemode renderer/result rewriting is added.

## Exports and compatibility

Pi also uses registered tool renderers for HTML export. An in-process export using the active renderer runtime can use its current preferences. A separate CLI export that loads this package starts with enabled defaults; session-only choices are not transmitted or reconstructed from the transcript. `/share-local` passes `--no-extensions`, so these formatters are absent and that command retains its ordinary CLI presentation.

Requires a host exposing `registerToolRenderer`; tested on Pi 1.2. The extension is inert on older hosts without that API, including no `/pretty` command there. The package's general peer floor is unchanged. No new shortcut, configuration schema, runtime path, or dependencies are introduced.

## Validation and limits

Run `npm run validate`, or `npx vitest run tests/pretty.test.ts` for focused coverage. Tests use explicitly synthetic recognition fixtures and the public Pi tool-row component, including pre-registration/resumed rendering, toggling existing rows without recursive invalidation, errors/partials/raw fallback, narrow Unicode layouts/padding, and theme changes. They are not captured Xcode payloads or live schema verification. No live MCP/provider calls, project builds, or manual terminal/HTML walkthrough were performed. Unknown real-world shapes remain in the original view until supported safely.
