# Coordination protocol v1 — first messaging slice

Status: implemented local autonomous communication, wire protocol 1 / SQLite schema 2 / activation policy 2. Health advertises the policy revision so managed startup replaces known older-policy brokers without resetting usage or data; unknown future policies are preserved. The HTML remains the broader architecture proposal. Automatic activation is enabled for joined, unpaused participants; decision authority and moderation remain deferred.

## Runtime and topology

- Node 24.15+ (built-in `node:sqlite`), Pi 0.85.1+, macOS/Linux Unix sockets.
- One automatically managed per-user broker (join/reconnect starts or reuses it; 60s without connections shuts it down); SQLite WAL + `synchronous=FULL`, foreign keys, schema version 2. All application writes through broker transactions.
- Runtime directory: `${PI_CODING_AGENT_DIR || ~/.pi/agent}/coordination`. Private directory (0700), database/socket/control credential (0600). No project-local configuration or automatic room discovery.
- Independent named rooms, each with immutable ID, memberships, messages, threads, pause, and inboxes. Same repository can use different rooms; different repositories can join the same room.
- Initial extension: one room per session, multiple concurrent rooms across sessions. Protocol is explicitly room-scoped, without a global current-room singleton. Multiple memberships inside one model context remain deferred.

Startup/recovery uses a private `startup.sqlite` write transaction to serialize probe → stale-socket cleanup → bind, including optional foreground startup and cleanup. Kernel locks release on crash; there is no stale PID-lock takeover or agent-written shared state. Only a verified owned socket refusing connections can be removed. Healthy brokers are reused; auth/protocol/timeouts/storage errors never trigger destructive recovery. A detached child reports readiness/errors over IPC; no shell or cwd-dependent npm invocation is involved. Factory/session startup without enrollment remains side-effect-free.

Known schema-1 brokers are gracefully stopped under the startup gate and replaced automatically. Schema 1 -> 2 is an additive transactional migration (eligibility, activation ledger/thread charges, pause reasons); credentials/messages/idempotency remain intact. Existing open requests and first pending requested replies acquire eligibility, with current thread/obligation checks at dispatch. Unknown schemas fail closed without resetting data.

## Wire transport

UTF-8 JSON, strict LF framing, maximum 256 KiB per frame. Partial/coalesced socket reads are handled. Oversized, malformed, incompatible, or unauthenticated frames fail closed. Requests and responses have `v: 1` and `id` (request correlation); server hints have `event: "changed"` and a room ID. Hints are coalescible, not delivery receipts. Clients fetch authoritative state after hints/reconnect and heartbeat, with no LLM polling.

First request: `hello` with either a private control credential or a participant credential plus concrete session ID. Subsequent requests inherit the authenticated actor; no caller-supplied sender field. Control credentials are read for user controls, reload restoration, and host-side broker health/bootstrap (including enrolled reconnect), never exposed in tools or session content. The same-OS-user shell trust limitation applies; this is not a sandbox.

Request shape: `{v:1,id,op,params}`. Response: `{v:1,id,ok:true,result}` or `{v:1,id,ok:false,error:{code,message}}`. A response timeout/disconnect means acceptance may be unknown. An incompatible schema is never automatically reset.

## Operations

- Control: `join` (room/name/role/session ID, explicit rejoin flag), `restore` (same room participant + session on reload), `leave`, `pause` (local membership or room), `resolve` (close thread), `cancel` (cancel request), `redirect` (same-room replacement), `answer` (attributed human reply), `health`, `stop`.
- Host-only worker activation operations (not agent tools): `auto-reserve` (eligible batch + durable budget reservation), `auto-dispatch` (final broker pause/eligibility check), `auto-cancel` (host proves no Pi insertion was invoked), `auto-finish` (persisted entry evidence and complete/aborted/error/unknown outcome). Scope is always the authenticated participant/session. Dispatch requires the current generation; evidence reconciliation can use a fresh connection for the same session.
- Worker: `status`, `send`, `read` (inbox/thread/message; cursor pagination), `ack` (own delivery only), `heartbeat` (observed runtime), `work` (own summary/blocker only), `claim`, `queue` (recipient-adapter acceptance), `receipt`, `uncertain`, `reconcile`, `retry` is control-only.
- Every room operation requires its room ID. Workers can only access their joined room. Thread, reply, recipient, delivery, and redirect IDs must belong to that room. Human controls target exact room/participant records and are not in worker tool schemas.
- `send`: idempotency key, recipient IDs (1–8), type (`question`, `reply`, `proposal`, `decision_request`, `handoff`, `status`), body (16 KiB UTF-8), optional subject/thread/reply ID, optional actionable boolean (handoffs only), and up to 8 bounded opaque artifact references. References are never fetched. No automatic broadcast.
- Unique `(room, sender, idempotency key)`: identical payload retry returns the original message identity with current delivery states; changed payload conflicts. A send transaction allocates immutable message ID, thread sequence and recipient delivery rows before success. Concurrent replies never overwrite message history.
- Bounded queues reject before accepting a new send; never evict accepted messages to admit new ones. Inbox/history pages max 20 summaries, message body fetched separately. Default inbox queries show pending/uncertain deliveries, open requests and unacknowledged active items; optional history=true includes inactive/acknowledged records. Thread history always remains complete. Room rosters contain 80-byte work previews; `status` with an optional participantId retrieves that participant's complete work summary/blocker. Tools additionally cap output at 40 KiB/1,800 lines with lookup instructions.

## Identity / lifecycle

Participant names unique within a room; immutable participant IDs are authorization keys. Explicit rejoin can recover a disconnected/left participant; changing session binding requires user confirmation. A live binding cannot be silently taken over, even by name. Each worker connection increments a persisted generation; every operation revalidates session, generation, connection and heartbeat lease. Reload restores only the exact current session binding. New/resume/fork/clone/startup do not autojoin. Transport reconnect while the same session remains enrolled is automatic with bounded backoff.

Heartbeat every 5 seconds, lease 20 seconds. Working/idle/waiting-for-user/unknown are observations, not self-reported work. Paused and left are independent flags. Broker loss shows stale/unknown rather than claiming every participant left. Broker restart invalidates live connections; uncertain local delivery attempts stay visible.

## Automatic activation and delivery

Message acceptance `stored` is separate from per-recipient `pending`, `claimed` (broker reservation), `queued` (recipient adapter accepted), `recorded`, `uncertain`, `cancelled`. Explicit acknowledgment timestamp and request-obligation state are separate. A question/decision request expects input from each addressed participant; replies to it answer only the replying participant's obligation. Thread resolution is explicit, not inferred from “agreed.”

Eligibility is persisted per recipient: open questions/decision requests, handoffs explicitly marked actionable (existing authorized scope only), and first replies satisfying an outstanding recipient obligation (wake the requester only). Status/proposal/informational handoff/courtesy reply/ACK do not wake models. New peer sends to oneself do not auto-wake. Actor permission and idempotency checks still apply.

At idle, the host coalesces hints for 200ms and reserves up to four eligible messages, then revalidates broker pause/obligation/thread state before dispatch. A single attributed custom batch is submitted through `pi.sendMessage` with `deliverAs:followUp, triggerTurn:true`. Native Pi idle/pending-input checks happen immediately before the synchronous invocation. Busy work, compaction, retries and user prompts are never steered/interrupted. `agent_settled` schedules pending work; transport hints and heartbeats make no model calls on their own.

Budget reservations are atomic with delivery claims: 100 per room per rolling hour, shared across recipients, with no lifetime thread cap. Batches charge the room once; thread associations are retained for audit only. Cancelled-before-insertion reservations can be refunded; unknown outcomes stay charged and never automatically retry. Limits survive restart/rejoin; room windows age naturally. Status/widget exposes budget-blocked attention. An activation is not a token/cost limit.

`/team deliver <message>` remains optional manual insertion with `triggerTurn:false`, not the normal communication path.

Manual `claim` or automatic reservation records attempt/session/generation; only the recipient's subsequent `queue` acknowledgment or automatic dispatch marks it queued locally. Disconnect during either in-flight phase becomes `uncertain`. After insertion, the adapter must observe the matching custom-message entry in its own session; it reports `recorded` only with persistence evidence. Pi's insertion API alone is not a durable receipt. In-memory/new unflushed sessions cannot claim persisted recording. Reconciliation searches only this session's own persisted coordination entries; matching message+participant+session IDs reconcile without reinsertion. Absence is not proof of nonexecution: uncertain delivery requires an explicit user retry. No exactly-once model execution guarantee, no direct session-file writes.

Pause blocks new claims and automatic dispatch. A dispatch committed before pause may already be in flight; pause does not retract it, abort an agent, or undo side effects. Local pause is checked immediately before insertion. Resume processes still-eligible pending work, not recorded/uncertain history. Abort, final model error, and unknown automatic startup outcomes pause that participant until explicit local resume. Connection/session/broker loss during an active reservation/run marks it uncertain and conservatively pauses the recipient; no execution is inferred or retried. Persisted batch markers can reconcile individual deliveries without another wakeup.

Reading from an agent tool explicitly puts the selected content in the tool result; this is an on-demand read, not a custom-context delivery receipt or automatic ACK. Human inbox inspection never marks agent delivery complete. ACK does not imply understanding or task completion. Branch navigation/compaction never rolls back broker state or auto-replays history.

## Availability and review

Stored sends report each recipient's observed presence and actual delivery state. Status derives attention for pending deliveries to unavailable/left recipients, open requests to unavailable participants even after delivery, and uncertain attempts. The widget shows persistent summary counts; status/inbox provide detail. No repeated blocking disconnect dialogs. On reconnect refresh pending counts and process still-eligible work at idle; never re-trigger uncertain execution. No expiry or overdue timer in this pilot; messages persist until explicit cancellation or history deletion.

Human review can keep waiting (no mutation), cancel a request, redirect within the same room, answer with explicit human attribution, or resolve a thread. Redirect retains the original message and marks the previous obligation redirected; the new recipient gets its own delivery. Late arrivals see current request/thread state and cannot silently reactivate cancelled/resolved/redirected obligations. Human answers are not protected decision approvals; decision tooling is not exposed.

## Privacy / limitations

Explicit peer messages delivered/read by an agent are sent to its configured model provider. No automatic transcript, prompt, environment, private file, credential, or hidden-reasoning sharing. Work summaries and artifact references are explicit opt-in text. Membership and message metadata persist locally, including the session binding. Runtime credentials are never committed.

No remote broker, dashboard, task board, spawning, merges, deployments, moderator grants, or approved-decision records in this slice. Broker stop is authenticated and preserves history. Backup/export/deletion operations and exact user command syntax are documented in `agent-coordination.md`.
