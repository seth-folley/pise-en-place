# Pise

A local, read-only macOS menu bar companion for the Pi usage and skill-read ledgers.

## Build and run

Requires macOS 26+ and Xcode 27+ / Swift 6.4. The local **PiseKit** package declares The Composable Architecture (TCA) 1.26.2 in `Package.swift`; `Package.resolved` pins its transitive dependencies. Fetching/building dependencies needs network access initially; the running app does not.

```bash
open mac/Pise.xcworkspace
```

The workspace opens the **Pise** app project and local **PiseKit** package together, so both are editable in one navigator. Open the workspace rather than the project alone.

**One-time app linkage (if not already done):** Select the **Pise** app target → **General → Frameworks, Libraries, and Embedded Content → +**, then choose the workspace's **PiseKit** library product. Only the local product belongs on the app target; TCA is owned transitively by the package. Save the project and include Xcode's generated product-reference changes in your commit. Workspace membership does not itself link the app to the library; the current automation tools cannot attach package products.

Select the shared **Pise** scheme and **My Mac**, then Run. Click the chart icon in the menu bar. Pise has no Dock icon or main window; Quit is in the popover. It does not install itself or launch at login.

From the repository root:

```bash
# Package builds/tests work independently of the Xcode app hookup.
swift build --package-path mac/PiseKit
swift test --package-path mac/PiseKit

# After attaching PiseKit in Xcode:
xcodebuild -workspace mac/Pise.xcworkspace -scheme Pise \
  -destination 'platform=macOS' build
xcodebuild -workspace mac/Pise.xcworkspace -scheme Pise \
  -testPlan Pise -destination 'platform=macOS' test
```

The app uses local/ad-hoc signing without requiring a development team. Configure your own signing identity for distribution; no App Store packaging or notarization workflow is included.

All tests live in the package's **PiseKitTests** target and need no app test host. The shared Pise test plan points at these package tests for use after the hookup. The template's old **PiseTests** and **PiseUITests** targets are unused and excluded from the scheme/plan.

## Interface

- **Overview:** estimated USD cost, tokens, known sessions, daily chart, top projects and models.
- **Breakdown:** project/model rankings, project-scoped branches, tags, and token composition.
- **Skills:** command invocations and file-read events, known sessions using skills, and project associations. Expand a skill to inspect its counts and projects.
- **Today / Week / Month:** shared time range; defaults to Today.
- **Project:** shared filter. Selecting a new project clears model/branch/tag filters.
- **Models, branches, tags:** usage-only filters. These do not affect Skills; the UI states this explicitly.
- **Estimated cost / Tokens:** switches chart/ranking metric in the usage views.
- **Refresh**, **Clear filters**, and **Quit** are available in the popover. Filters are in-memory only.

Long rankings scroll inside the popover. Short project labels are displayed; full recorded identities remain available in breakdown tooltips. Same-named projects are qualified by their trailing path components.

## Data and privacy

Pise reads these existing paths:

```text
~/.pi/agent/usage/ledger.jsonl
~/.pi/agent/skill-reads/ledger.jsonl
```

It is deliberately **non-sandboxed** for personal use, so these files need no folder-picker authorization. This is not a filesystem security boundary. The implementation does not write the ledgers, open session transcripts, invoke Git/Pi, access account credentials, make network requests, or store an additional database/cache. Recorded project/session metadata stays in memory. No prompts, responses, or skill contents are loaded.

SwiftUI previews and automated tests use synthetic data or disposable temporary files, not your ledgers. Previews disable live effects; reducer tests inject ledger/application clients and a virtual clock. Tests do not launch the Pise app or install/configure Pi. The visibility integration test creates a temporary AppKit panel.

## Reporting semantics

- Schema version 1; unknown fields are ignored, unsupported versions are counted separately. Additive optional `kind`/`usageKind` metadata is compatible with older assistant-only rows. Assistant, tool/nested-model, compaction, branch-summary, and separate usage rows all contribute to existing totals. Unknown provider/model attribution remains unknown.
- Counts mean usage-bearing records, not exact provider-request counts; a tool/summary row may aggregate several requests.
- Records must have valid timestamps and nonnegative finite usage values. Invalid records are skipped and counted.
- Only newline-terminated rows are committed. An unfinished final fragment is deferred, even if it happens to contain valid JSON; it is not counted as corruption.
- Duplicate rows are retained, matching `/usage` rather than silently rewriting history.
- Local-time calendar boundaries; Week means Monday-to-now, Month means month-to-now. Future timestamps are excluded.
- Project grouping uses recorded Git remote, common Git directory, Git root, then cwd. Models are provider-qualified. Missing branches are `untracked` within their project.
- Costs are Pi-reported estimates, not subscription bills or account limits. **—** means no estimate is available; **\*** marks a subtotal with missing estimates. Rankings use known estimates only, so incomplete coverage can change the order. A reported zero is not treated as missing.
- Tag totals overlap because one usage record can have multiple tags. Repeated tags on the same record count once per tag.
- Usage sessions are distinct nonempty recorded session-file identities. Skill sessions use session-file identity, with session ID as a fallback. Missing identities do not create invented sessions.
- Skill-command and read-tool events are separate events, not deduplicated tasks. Discovery is not a load event. Counts measure adoption, not effectiveness.
- Project attribution is honored independently in each ledger. A usage-only `.pi/usage.json` override can differ from the skill ledger's Git-derived identity; Pise does not heuristically merge those projects or rewrite attribution.
- Tracking begins when the extensions record activity; there is no historical backfill.

## Refresh and failure handling

The popover's actual hosting-window visibility is observed through a small AppKit bridge; SwiftUI appearance callbacks alone are not reliable for repeated `MenuBarExtra` openings. Callbacks from obsolete observations are rejected, and queued callbacks read the current window visibility rather than replaying historical values.

Opening reads both ledgers. While visible, event-only file/directory watchers detect appends, first creation, deletion, truncation, and replacement. Descriptors are rearmed immediately on changes, and report reloads are debounced by 300 ms. Each subscription also emits an initial reload signal: a post-subscription snapshot closes the setup race between the concurrent first read and watcher installation. This deliberately adds one debounced full reload on opening. A visible-only minute tick advances calendar-bound reports without reading files. Closing cancels the watcher stream, timer, debounce, and pending report effect; reopening reads fresh data. There is no idle polling.

Full JSONL snapshots are read/decoded by a dedicated actor, and aggregation runs there as well. `DashboardFeature` owns query/tab/report state and all lifecycle actions through TCA's `@Reducer` / `@ObservableState`. SwiftUI binds to a `StoreOf<DashboardFeature>`; there is no separate observable controller or view-driven refresh observer. `LedgerClient`, `ApplicationClient`, and the continuous clock are injected dependencies. Filter changes reuse the in-memory snapshot, and cancellable effects plus generation checks prevent superseded work from overwriting a newer query.

Missing ledgers have explanatory empty states. Permission/read errors are shown separately from zero activity. Either ledger can remain usable if the other fails. Skipped/unsupported records and pending fragments are shown in the relevant view. Refresh retries without modifying data.

## Source and validation

```text
Pise.xcworkspace/             shared app + local package workspace
Pise/
  Pise.xcodeproj/             native app target and shared scheme
  Pise.xctestplan             package-test plan
  Pise/PiseApp.swift         thin MenuBarExtra shell importing PiseKit
  Pise/Assets.xcassets/      application assets
PiseKit/
  Package.swift              macOS 26+ library and TCA dependency
  Package.resolved           pinned dependency graph
  Sources/PiseKit/
    PiseDashboard.swift      public dashboard view, package-owned root store
    App/                     reducer, observable state/actions, application client
    Models/                  Sendable ledger models and synthetic previews
    Ledger/                  injected client, actor reader, event-only watcher
    Reporting/               pure filtering/grouping/aggregation
    Views/                   reports, charts, components, visibility bridge
  Tests/PiseKitTests/        Swift Testing suites and synthetic fixture builders
```

Tests cover both schemas (including the shared TypeScript/Swift additive-v1 usage fixture), malformed/unknown records, fractional timestamps, partial appends, file read failures, duplicate rows, deletion/truncation/recreation/replacement, cost coverage, time boundaries/DST, project/model identity, tags, skill attribution/session counts, window visibility, production watcher rearming, and a 100,000-record synthetic aggregation. Exhaustive `TestStore` tests also cover filter actions, hidden/preview no-I/O behavior, open/close/reopen, cached versus full reads, minute ticks, debounce timing, stream teardown, in-flight cancellation, stale responses, failure/retry, and injected Quit behavior.

For manual verification:

1. Run Pise, open the icon, and switch all three views/ranges/metrics.
2. Select a project, inspect its branches/tags, then clear filters; confirm Skills uses only project/time.
3. Generate ordinary Pi activity while open and confirm totals refresh. Close/reopen and confirm fresh totals.
4. Check keyboard/VoiceOver navigation, scrolling, light/dark appearance, and Quit.

Do not delete or corrupt your real ledgers to exercise errors; automated tests use temporary files.

## V1 boundaries

No budget alerts, subscription-limit integration, login launch, preferences, export, custom paths, named-session browsing, AI insights, persistent rollups, or cross-ledger attribution inference. Full snapshot reloads prioritize simplicity; consider indexing only if measured ledger growth warrants it.
