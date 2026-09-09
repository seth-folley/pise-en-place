# Agent coordination — autonomous communication

Two independently launched Pi sessions can join an isolated team room and communicate without human message forwarding. **Automatic communication is enabled for joined, unpaused agents:** eligible messages wake idle recipients; busy recipients handle them after their current run settles. The broker supports multiple concurrent rooms. Spawning, approved-decision records, and moderator grants remain out of scope.

Design: [HTML architecture](agent-coordination-communication.html). Wire/storage contract: [protocol v1](agent-coordination-protocol.md).

## Requirements and install

- macOS/Linux; Unix sockets only.
- Node **24.15+**, using built-in `node:sqlite` (some Node versions print an experimental warning).
- Pi **0.85.1+**; validated against 0.85.1. The package's development types were updated to that version.
- Runtime dependency `tsx` starts the TypeScript broker. Pi loads the extension itself through its normal package loader.

From this package's checkout:

```bash
npm install
npm run validate
pi install .
```

This repository is the source of truth; do not copy extension source into `~/.pi/agent/`. If the local package is already installed, installation is unnecessary. Run **`/reload` in each participating Pi session** after installing/updating it. Creating files in this repository does not make the tools available in another already-running session until it reloads.

**Normal use needs no broker commands or service setup.** After `/reload`, run `/team join …` and confirm. Pi starts or reuses the per-user broker automatically, including creation of its private control key. This works from any repository directory.

The detached broker survives the terminal that started it. It exits after **60 seconds with no connections**, preserving all room/message history; an idle-but-connected agent keeps it alive. Leaving/quitting sessions needs no service teardown. A subsequent join or enrolled session's reconnect starts it again. Broker recovery itself makes no model calls; reconnected agents automatically process still-eligible pending messages. Uncertain earlier execution is never replayed automatically.

`npm run team:broker -- health|stop|start|backup <path>` remains optional maintenance, not setup. An enrolled session reconnects automatically after `stop`; detach sessions first when intentionally keeping the service down. Foreground `start` is for diagnostics and intentionally stays running until stopped. No launchd/systemd service is installed.

No coordination sockets, watchers, processes, or timers start in the extension factory. Session startup alone does not enroll anyone. Background heartbeat/reconnect begins only after an explicit join (or exact-session reload restoration).

### Updating activation limits

Reload participating sessions, preferably after their current runs settle. The host detects older activation-policy brokers and replaces them automatically, preserving messages, usage history and credentials. Previously thread-capped pending work becomes eligible without a reset or a new thread. An in-flight run interrupted during replacement retains the usual conservative pause/uncertainty handling; inspect it and use `/team resume local` when appropriate. Unknown future policies are preserved, not downgraded.

### Updating from the manual messaging version

Reload participating Pi sessions. The host gracefully replaces a known schema-1 broker and migrates its database transactionally to schema 2; memberships, credentials, messages and idempotency keys remain intact. Clients reconnect automatically. Unknown future schemas or invalid endpoints are preserved and reported rather than reset. Existing open requests and first pending requested replies become eligible; closed/recorded history does not replay. Existing local/room pauses remain in force. Reloaded, unpaused memberships now opt into the approved automatic defaults.

## Join a specific room

In the app repository's Pi session:

```text
/team join disc-catalog --name app --role worker
```

In the backend repository's independently launched Pi session:

```text
/team join disc-catalog --name backend --role worker
```

Confirm enrollment in the TUI. The first join creates the room. Names use letters/numbers/dot/hyphen/underscore, max 48 characters; they are case-sensitive. Role is a display/workflow label in this slice, not a permission grant.

A different set of sessions can simultaneously join, for example, `website-redesign`. Rooms have distinct immutable IDs, members, mailboxes, threads, pauses, and history; sharing the broker or repository does not share membership. **The pilot supports one room per Pi session**, not one room per machine. Use a separate session for a different team. Multi-room membership inside a single session/model context remains deferred.

No session is discovered or joined by scanning its directory. The tools reject cross-room recipient/thread/message IDs. All model-facing sends/reads name the explicit room ID.

### Recover a previous participant

Names cannot steal an identity. If a name already exists, disconnect/leave its old session, then explicitly rejoin:

```text
/team join disc-catalog --name backend --role worker --rejoin
```

This recovers the existing participant/mailbox and can bind it to this session after human confirmation. A **live** binding cannot be taken over; wait for its connection to close or its 20-second heartbeat lease to expire. Existing roles are preserved; rejoin cannot upgrade them.

- `/reload`: restores only the exact same saved participant/session binding, with fresh credentials/generation. If recovery fails, explicitly rejoin.
- Startup/restart, `/new`, `/resume`, `/fork`, `/clone`: **no automatic enrollment**. Use explicit rejoin as appropriate, including when resuming the same saved session.
- Network/broker reconnect while the same session remains enrolled: automatic bounded backoff, then eligible pending work can wake the agent at idle. Historical/recorded/uncertain deliveries are not automatically replayed. An interrupted automatic run conservatively pauses its participant for human review.
- `/team leave`: stops delivery; keeps messages/history. If the broker is unavailable, confirms local detach and stops reconnect attempts, but does not claim the broker recorded a departure.
- Tree navigation and compaction never undo broker state or resend historical messages.

## Persistent widget and detailed status

A small widget above the editor uses the local subagent tray's rounded border, inset bold accent title, and padded rows. It shows the current room, connected counts, up to four participant rows, open requests/threads, and attention count. Larger teams get an overflow count. The existing footer is preserved. Text labels and semantic theme colors support light/dark themes; lines are terminal-width bounded.

```text
TEAM disc-catalog · 2/2 connected
  app (you) · working
  backend · idle · 1 needs reply
  1 requests · 1 threads · 0 attention · /team status
```

`/team status` writes a detailed **TUI-only** inspection entry, not a model prompt: IDs, observed runtime, connection/last heartbeat, pause, inbox counts, and agent-reported summaries/blockers. Broker outage labels cached status **STALE**, never as live presence. `/team status disc-catalog` is also accepted for the joined room. Work summaries/blockers are previewed at 80 UTF-8 bytes to keep full rosters bounded; inspect one participant's full text using `/team status disc-catalog <participant-id>` or `team_status` with `participantId`.

Counts have distinct meanings:

- **Connected:** authenticated live connection with an unexpired lease. **Idle is connected**, not unavailable. Working/idle/waiting-for-user are observations updated by the extension; self-reported work is separate.
- **Pending:** deliveries not recorded in context, including queued/uncertain attempts. Unattempted deliveries made obsolete by an answer/resolution/cancellation are cancelled, not offered for replay.
- **Unread:** unacknowledged active items; answered/resolved/cancelled/reassigned obligations are excluded. Retiring an obligation is not proof the model read it; the acknowledgment timestamp remains separate. Human inspection does not mark agent input read.
- **Needs reply / requests:** open questions or decision-request messages awaiting specific recipient input. A reply answers the replying participant's obligation; courtesy replies are not expected.
- **Threads:** all open threads, including question threads, not an exclusive category to add to the question count.
- **Attention:** uncertain delivery, automatic budget exhaustion, or pending delivery/open request to a disconnected/left recipient. A question can require attention even if it was recorded before the recipient disconnected. Counts are per affected delivery, not duplicate popup events.

There is no overdue deadline or notification grace-period configuration yet. Presence changes update the widget/status, not repeated blocking dialogs. While disconnected, the service may take up to its heartbeat lease to detect a crash. On a valid reconnect, the inbox becomes visible through widget/status immediately; eligible pending messages can start a model run at the next idle boundary (unless paused or budget-blocked).

## Agent tools

### `team_status`

Read current enrollment, participant IDs, runtime and pending counts. Optional `roomId` verifies scope; optional `participantId` retrieves one participant's full work text instead of roster previews. `summary` and `blocker` update only the caller's own explicit text (empty string clears). Those updates are shared with the room. This tool is the starting point for discovering the room ID and recipients.

### `team_send`

```typescript
{
  roomId: string;
  idempotencyKey: string;          // unique per logical send; reuse on uncertain retry
  recipients: string[];           // 1–8 participant IDs, never display names
  type: "question" | "reply" | "proposal" | "decision_request" | "handoff" | "status";
  body: string;                   // max 16 KiB UTF-8
  subject?: string;               // required when creating a thread
  threadId?: string;
  replyTo?: string;               // required for reply; threadId must match
  references?: string[];          // max 8 opaque references, 1,000 bytes each; never fetched
  actionable?: boolean;           // handoffs only: continue an existing authorized assignment
}
```

Returns **STORED**, message/thread IDs, sequence, each recipient's observed availability and delivery state. Success means the SQLite transaction committed, **not** that another model received/replied/understood it. Offline/left recipients keep durable mailboxes; the sender does not hold a tool open waiting for an answer.

Same `(room, sender, idempotencyKey)` and payload returns the original message. A different payload under the same key is a conflict. On timeout/disconnect, acceptance may be unknown: retry only the same key/payload or inspect history. The extension does not silently spool unsent messages offline.

Agents should ask once, continue independent work or report a blocker, answer concretely, and return to their assignment. No inbox polling loops, status/ACK reply loops, or assumptions that peer agreement grants user permission.

### `team_read`

```typescript
{
  roomId: string;
  action?: "read" | "ack";        // defaults to read
  messageId?: string;             // full individual message, or target of explicit ack
  threadId?: string;              // thread summaries; omit IDs for own inbox
  cursor?: number;                // returned nextCursor, stable service ordering
  limit?: number;                 // 1–20 summaries
  history?: boolean;              // inbox: include inactive/acknowledged history (default false)
}
```

Read one full message, or a page of summaries (160-character preview; no full bodies). The default inbox shows pending/uncertain deliveries, open requests, and unacknowledged active items rather than burying new work under old resolved messages. Use `history: true` (or `/team inbox --history`) for all inbox history; thread queries always preserve full history. Follow `nextCursor` for history and fetch specific message IDs for details. Output additionally caps at 40 KiB/1,800 lines and identifies retrieval options. Reading is an explicit tool result in model context, **not** proof of custom-message insertion or an automatic acknowledgment. `ack` acknowledges only the caller's addressed message; it is not completion or approval.

## Human commands

```text
/team help
/team status [joined-room] [participant-id]
/team inbox [cursor] [--history]
/team thread <thread-id> [cursor]
/team read <message-id>
/team deliver <message-id>
/team reconcile <message-id>
/team retry <message-id>
/team review <message-id>
/team resolve <thread-id>
/team pause [local|room]
/team resume [local|room]
/team leave
```

### Automatic communication (default)

You do **not** need `/team deliver` or a separate prompt for each message. Ask an enrolled agent to use `team_send`; the recipient processes eligible messages automatically and a requested reply can wake the sender to continue its existing task.

| Message | Automatic wakeup |
|---|---|
| Question or decision request | Yes, while its recipient obligation and thread remain open |
| Reply | Only the first reply fulfilling an outstanding request, and only for its requester |
| Handoff with `actionable: true` | Yes; continuation of an existing authorized assignment only |
| Status, proposal, informational handoff, courtesy reply/ACK | No; available through inbox/tools without waking a model |

- **Idle:** coalesce arrivals briefly (200ms), reserve up to four eligible messages, insert one attributed batch, and trigger one run.
- **Busy/compacting/retrying/waiting for user or queued local input:** leave messages in the broker. Resume scheduling only at a safe idle boundary; never steer or interrupt active work.
- **Pause:** `/team pause local` or `/team pause room` blocks new automatic dispatch. `/team resume …` allows still-eligible pending work. A dispatch committed before pause may already be in flight and cannot be retracted.
- **Abort/error:** aborting an automatic run pauses this participant's further automatic delivery until `/team resume local`. Final provider errors or unknown startup outcomes also pause conservatively. This does not block normal user-directed local work.
- **Authority:** batches are peer input, not user permission. No scope expansion, unrelated delegation, permission grants, deployment approval, or safety-confirmation bypass.

**Durable budget:** 100 automatic activations per room per rolling hour, shared across all recipients. There is no lifetime thread cap. A batch consumes one room activation—not one per message; thread associations remain in the audit ledger without limiting the discussion. Reservations and uncertain outcomes count conservatively; only an explicitly proven not-inserted cancellation (including persisted-evidence reconciliation before dispatch) refunds a reservation. Restarts/reloads/rejoin never reset budgets. The rolling room allowance recovers as earlier reservations age out. Resume does not reset limits. The widget/status shows budget-blocked messages as needing human attention; use normal human-directed inspection/work while the room allowance is exhausted. These are activation caps, **not dollar/token caps**: one run may contain multiple model turns and tool calls.

No polling model runs, full-history replay, or status/ACK wakeup loops. A successfully recorded message is never automatically delivered again. Uncertain dispatch requires evidence/review rather than an automatic retry.

### Optional manual insertion

`/team deliver <message-id>` remains available for informational messages and deliberate human-directed work. It records one message while idle without starting a model; prompt the agent afterward if desired. Busy/paused manual insertion is rejected. Normal eligible traffic does not require this command.

The content visibly names team, author/role, type, thread, sequence, and message ID. Peer text is labeled **not user authorization**, including in the model-visible body—not merely renderer metadata.

### Unavailable recipient review

Use `/team review <message-id>` and select the affected recipient:

- **Keep waiting:** no mutation; mailbox remains durable.
- **Answer as human:** enter and confirm an attributable answer. It resolves that recipient's open input obligation and notifies the original sender/recipient through stored replies. It does not approve protected decisions or permissions. Stale review of an already-answered/cancelled request is rejected.
- **Redirect within room:** explicitly select another joined participant. Preserve original sender, message/thread and history; mark original obligation redirected and create a target delivery. No cross-room redirection. Content already recorded cannot be retracted.
- **Cancel request:** cancel that recipient's outstanding obligation/unattempted delivery without deleting history.

`/team resolve <thread-id>` explicitly closes the discussion. Merely saying “agreed” does not do this. Requests answered, redirected, cancelled, or resolved while someone was away remain inspectable, but cannot be blindly delivered as new work on reconnect.

All human mutation/review controls require TUI confirmation. There is no worker-callable approve, join, delegation, shell-execution, or arbitrary sender tool. RPC/headless human controls are not supported in this pilot: unavailable UI means pending/not granted. Headless agents can use the structured tools once explicitly bound by an appropriate future host; enrollment in this version is designed for TUI sessions.

### Delivery uncertainty / recovery

States are per recipient: `pending → claimed → queued → recorded`, with `uncertain` and `cancelled` alternatives. Claimed means reserved by the broker; queued means the recipient adapter actually acknowledged accepting it for insertion, not merely that a socket event was sent. Explicit acknowledgment and input obligation are separate fields.

A broker claim and Pi session insertion cannot be one atomic transaction. If an extension crashes after insertion but before receipt, the broker marks the delivery uncertain. `/team reconcile <message-id>` checks this exact participant/session's own persisted custom-message entry and sends its entry ID as evidence without reinserting. It does **not** upload a transcript or write another session's file.

A new Pi session may not have flushed to disk until an assistant message exists. Ephemeral sessions never persist. If insertion cannot be proven on disk, report uncertainty rather than false durable delivery. The entry may become reconcilable after a later normal user turn flushes the session.

If reconciliation cannot establish a receipt, `/team retry <message-id>` requires explicit human confirmation and resets an uncertain delivery to pending. Inspect before retrying; prior execution cannot be ruled out. An eligible retried message can wake automatically if unpaused and within budget. Both manual and automatic paths check persisted message IDs before reinsertion; a previously recorded batch is reconciled/held rather than re-triggered. No exactly-once model execution guarantee or whole-history replay.

## Storage, privacy, operation

Default paths, honoring `PI_CODING_AGENT_DIR`:

```text
~/.pi/agent/coordination/
  broker.sock       Unix socket, current OS user only
  broker.sqlite     durable messages, memberships, deliveries, threads, audit events
  broker.sqlite-wal / broker.sqlite-shm    SQLite runtime companions
  control.key       private local human-control credential; never show to a model
  startup.sqlite    short-lived SQLite startup lock; kernel releases it on crash
```

Directory mode 0700; database/socket/credential 0600. Socket path must be at most 100 UTF-8 bytes for macOS portability. If necessary, set a shorter `PI_CODING_AGENT_DIR` consistently for broker and Pi; this changes Pi's user config directory too. Do not run several broker instances against the same directory. OS socket bind—not a locked shared application-state file—establishes one serving owner.

- Explicit messages, artifacts references, participant/session binding metadata, and explicit work summaries are local shared data. No automatic system prompt, environment, keys, session transcript, hidden reasoning, private app data, or filesystem/network fetching.
- Messages delivered/read by an agent are sent to its configured model provider. Local transport is not necessarily local inference.
- Same-user unrestricted shell processes can access private files and bypass workflow conventions. This is **not a security sandbox** for hostile agents.
- Graceful stop preserves history. Crash recovery is automatic: startup is serialized with a short SQLite write transaction before probing/removing a refused stale socket and binding the replacement. Concurrent joins reuse one broker without resetting live leases. Live, timed-out, non-owned, or non-socket endpoints are preserved, never blindly removed. Permission/auth/schema errors remain visible and never reset history. The optional cleanup command uses the same startup gate; do not manually unlink sockets or the gate file.
- Unwritable storage/protocol/schema errors do not grant false send success or reset data. Inspect errors and preserve the database. Coordination failure does not prevent local coding.

Consistent backup (new destination only, 0600, can run while the broker is live):

```bash
npm run team:broker -- backup /absolute/path/to/coordination-backup.sqlite
```

Do not copy just a live database while ignoring its WAL. Backups include explicit message content and require the same privacy care as the original.

For human-readable exports, use a local SQLite inspection tool on a backup; automated decision-log export is deferred with decision records. Keep exports out of Git unless you explicitly intend to share that content.

**Deletion:** there is no automated room-deletion command in this slice. To delete all coordination data, first back up if desired, detach all sessions, stop the broker, inspect the runtime path, and explicitly remove the coordination directory yourself. Never delete only the database while a broker runs. For selective deletion, retain the original database and wait for a reviewed room-deletion/migration utility rather than issuing ad hoc live SQL.

Uninstall with `pi remove /absolute/path/to/pise-en-place` (removes the whole package, not just this extension), or disable the coordination extension using `pi config`. Reload sessions; the managed broker exits when unused. Stop an optional foreground diagnostic broker if you started one. Runtime history is preserved unless explicitly deleted. There is no service registration to remove.

## Live two-terminal smoke test (visual/provider walkthrough still unperformed)

1. Install/reload the package in two existing Pi terminals in different repositories. **Do not start a broker manually.** Saved sessions are recommended; new sessions flush recording evidence once the assistant responds.
2. Join the same room as `app` and `backend`. Inspect `/team status`: both connected, their actual observed runtime, no transcript/credential leaks.
3. Ask app to use `team_status`, then `team_send` to ask backend “Can missing flight numbers be null?”. Confirm STORED, stable message/thread IDs, no synchronous wait.
4. Leave backend idle. Confirm it automatically receives the question, runs, and replies with `team_send` in the same thread. App should automatically receive the reply and continue its assigned work. Do not forward/deliver/prompt either recipient manually.
5. Quit backend. Send another question; see pending/disconnected attention rather than delivered success. Restart/rejoin backend with `--rejoin`; see still-eligible pending messages processed automatically. Recorded/cancelled/resolved messages must not replay.
6. Repeat with backend busy, local/room pause, explicit resume, and a broker restart. Confirm busy agents are not interrupted, paused agents do not wake, abort latches a local pause, and budgets survive restart. Reload the same session; then fork/new/resume and verify explicit rejoin is required.
7. Use review to answer/redirect/cancel an offline question; reconnect the original recipient and confirm obsolete work is not offered for delivery. Inspect preserved history.
8. Run a second room in other sessions. Verify no participant/thread leakage or cross-room sends. Manually check the widget/status in both themes and a narrow terminal.

## Validation coverage / handoff status

Automated suites use temporary storage, injected clocks, real Unix sockets, fake Pi adapters, and actual Pi SDK agent loops with a deterministic fake model transport. No live provider/network credentials are needed.

- `store.test.ts`: durable acceptance/restart, idempotency, reply order, pagination/limits, room isolation, name/session fencing, leases/pause, uncertainty/retry/reconciliation, human review and schema preservation.
- `transport.test.ts`: real socket/SQLite exchanges, concurrent sends, authenticated controls, protocol framing/rejection, private paths, single-broker ownership, restart and failure containment.
- `delivery.test.ts`: safe manual insertion, busy/pause boundary, insertion/receipt crash window, ephemeral uncertainty, persisted deduplication, exact-session evidence, widget summary semantics.
- `extension.test.ts`: actual extension factory against fake Pi host + real broker; explicit/declined/headless enrollment, manual-insertion behavior, width bounds, reload identity and replacement detach, offline status/leave.
- `managed.test.ts`: concurrent cold-starts from independent processes, SIGKILL/stale-socket recovery without losing room identity, live-agent preservation, idle shutdown and restart. The extension suite also tests confirmed `/team join` from a fresh directory and that a declined join creates no control key.
- `cli.test.ts`: separate packaged broker process plus independently launched fake clients exchange an offline question/reply, create a consistent private backup, and stop cleanly. This is a process-level smoke test, not a live Pi/LLM walkthrough.

- `automation-store.test.ts`: eligibility, batching, requested versus courtesy replies, continued long threads and durable room limits, pause/cancel revalidation, crash fencing, and schema-1 migration.
- `automation.test.ts`: coalesced hints, changed-session/busy boundaries, unknown send acceptance, persisted deduplication, and failed receipt evidence.
- `automation-sdk.test.ts`: two actual SDK agent loops exchange a question/reply through real tools with no human forwarding; busy recipients defer until settlement; abort pauses until explicit resume. Model output is simulated, not a live provider call.

Covered portions correspond to **AT-01–07, AT-10–13** and the nonvisual portions of **AT-14–15**. This is not a claim that every acceptance scenario is complete: AT-08–09 decisions/moderation, complete export tooling, and live AT-14/15 visual/install walkthroughs remain outstanding. No implementation checkboxes in the original requirements brief are marked as full-system completion.

Run `npm run validate` for current counts; autonomous SDK-loop, policy, recovery, and lifecycle tests pass. A separate check used Pi's actual extension loader with a fake command context to cold-join from an unrelated working directory, without a broker/key precreated. This proves loader/path/bootstrap integration, not live visual TUI behavior. Previously, `npm audit` reported **0 vulnerabilities**. Pi's actual 0.85.1 extension loader successfully registered `/team` and all three tools. `npm pack --dry-run` included the required coordination sources/docs and no runtime database, socket, or credential files. The separate-process fake-client question/reply and backup smoke test passed. **The live two-Pi-terminal/LLM walkthrough and manual theme inspection were not performed.**

Run `npm run validate` for current test results. Installation/reload and the live terminal walkthrough remain user actions unless explicitly reported as performed. The initial package version is still 1.0.0; source changes are in this checkout, not a published release or committed handoff revision.
