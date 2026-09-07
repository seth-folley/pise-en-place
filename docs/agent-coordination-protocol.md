# Coordination protocol v1 — first messaging slice

Status: implementation contract for the local/manual pilot. The HTML remains the broader architecture proposal; this document specifies the implemented slice. Automatic model activation and decision authority are not part of v1.

## Runtime and topology

- Node 24.15+ (built-in `node:sqlite`), Pi 0.85.1+, macOS/Linux Unix sockets.
- One automatically managed per-user broker (join/reconnect starts or reuses it; 60s without connections shuts it down); SQLite WAL + `synchronous=FULL`, foreign keys, schema version 1. All writes through broker transactions.
- Runtime directory: `${PI_CODING_AGENT_DIR || ~/.pi/agent}/coordination`. Private directory (0700), database/socket/control credential (0600). No project-local configuration or automatic room discovery.
- Independent named rooms, each with immutable ID, memberships, messages, threads, pause, and inboxes. Same repository can use different rooms; different repositories can join the same room.
- Initial extension: one room per session, multiple concurrent rooms across sessions. Protocol is explicitly room-scoped, without a global current-room singleton. Multiple memberships inside one model context remain deferred.

Startup/recovery uses a private `startup.sqlite` write transaction to serialize probe → stale-socket cleanup → bind, including optional foreground startup and cleanup. Kernel locks release on crash; there is no stale PID-lock takeover or agent-written shared state. Only a verified owned socket refusing connections can be removed. Healthy brokers are reused; auth/protocol/timeouts/storage errors never trigger destructive recovery. A detached child reports readiness/errors over IPC; no shell or cwd-dependent npm invocation is involved. Factory/session startup without enrollment remains side-effect-free.

## Wire transport

UTF-8 JSON, strict LF framing, maximum 256 KiB per frame. Partial/coalesced socket reads are handled. Oversized, malformed, incompatible, or unauthenticated frames fail closed. Requests and responses have `v: 1` and `id` (request correlation); server hints have `event: "changed"` and a room ID. Hints are coalescible, not delivery receipts. Clients fetch authoritative state after hints/reconnect and heartbeat, with no LLM polling.

First request: `hello` with either a private control credential or a participant credential plus concrete session ID. Subsequent requests inherit the authenticated actor; no caller-supplied sender field. Control credentials are read for user controls, reload restoration, and host-side broker health/bootstrap (including enrolled reconnect), never exposed in tools or session content. The same-OS-user shell trust limitation applies; this is not a sandbox.

Request shape: `{v:1,id,op,params}`. Response: `{v:1,id,ok:true,result}` or `{v:1,id,ok:false,error:{code,message}}`. A response timeout/disconnect means acceptance may be unknown. An incompatible schema is never automatically reset.

## Operations

- Control: `join` (room/name/role/session ID, explicit rejoin flag), `restore` (same room participant + session on reload), `leave`, `pause` (local membership or room), `resolve` (close thread), `cancel` (cancel request), `redirect` (same-room replacement), `answer` (attributed human reply), `health`, `stop`.
- Worker: `status`, `send`, `read` (inbox/thread/message; cursor pagination), `ack` (own delivery only), `heartbeat` (observed runtime), `work` (own summary/blocker only), `claim`, `queue` (recipient-adapter acceptance), `receipt`, `uncertain`, `reconcile`, `retry` is control-only.
- Every room operation requires its room ID. Workers can only access their joined room. Thread, reply, recipient, delivery, and redirect IDs must belong to that room. Human controls target exact room/participant records and are not in worker tool schemas.
- `send`: idempotency key, recipient IDs (1–8), type (`question`, `reply`, `proposal`, `decision_request`, `handoff`, `status`), body (16 KiB UTF-8), optional subject/thread/reply ID and up to 8 bounded opaque artifact references. References are never fetched. No automatic broadcast.
- Unique `(room, sender, idempotency key)`: identical payload retry returns the original message identity with current delivery states; changed payload conflicts. A send transaction allocates immutable message ID, thread sequence and recipient delivery rows before success. Concurrent replies never overwrite message history.
- Bounded queues reject before accepting a new send; never evict accepted messages to admit new ones. Inbox/history pages max 20 summaries, message body fetched separately. Default inbox queries show pending/uncertain deliveries, open requests and unacknowledged active items; optional history=true includes inactive/acknowledged records. Thread history always remains complete. Room rosters contain 80-byte work previews; `status` with an optional participantId retrieves that participant's complete work summary/blocker. Tools additionally cap output at 40 KiB/1,800 lines with lookup instructions.

## Identity / lifecycle

Participant names unique within a room; immutable participant IDs are authorization keys. Explicit rejoin can recover a disconnected/left participant; changing session binding requires user confirmation. A live binding cannot be silently taken over, even by name. Each worker connection increments a persisted generation; every operation revalidates session, generation, connection and heartbeat lease. Reload restores only the exact current session binding. New/resume/fork/clone/startup do not autojoin. Transport reconnect while the same session remains enrolled is automatic with bounded backoff.

Heartbeat every 5 seconds, lease 20 seconds. Working/idle/waiting-for-user/unknown are observations, not self-reported work. Paused and left are independent flags. Broker loss shows stale/unknown rather than claiming every participant left. Broker restart invalidates live connections; uncertain local delivery attempts stay visible.

## Delivery and manual insertion

Message acceptance `stored` is separate from per-recipient `pending`, `claimed` (broker reservation), `queued` (recipient adapter accepted), `recorded`, `uncertain`, `cancelled`. Explicit acknowledgment timestamp and request-obligation state are separate. A question/decision request expects input from each addressed participant; replies to it answer only the replying participant's obligation. Thread resolution is explicit, not inferred from “agreed.”

No automatic wakeups, steering, or next-turn queues in this slice. `/team deliver <message>` explicitly inserts one pending message at idle through `pi.sendMessage` as labeled peer input, with `triggerTurn:false`. This does not start a model run; the user prompts Pi to act. Busy or paused delivery fails with an actionable explanation instead of waiting indefinitely or queueing hidden work.

Before insertion, broker `claim` records the attempt/session/generation; only the recipient's subsequent `queue` acknowledgment marks it queued locally. Disconnect during either in-flight phase becomes `uncertain`. After insertion, the adapter must observe the matching custom-message entry in its own session; it reports `recorded` only with persistence evidence. Pi's insertion API alone is not a durable receipt. In-memory/new unflushed sessions cannot claim persisted recording. Reconciliation searches only this session's own persisted coordination entries; matching message+participant+session IDs reconcile without reinsertion. Absence is not proof of nonexecution: uncertain delivery requires an explicit user retry. No exactly-once model execution guarantee, no direct session-file writes.

Pause blocks new claims. A manually authorized claim committed before pause can already be in flight; pause does not retract that operation, abort an agent, or undo side effects. Local pause is checked again immediately before insertion. There is no automatic queue to replay on resume.

Reading from an agent tool explicitly puts the selected content in the tool result; this is an on-demand read, not a custom-context delivery receipt or automatic ACK. Human inbox inspection never marks agent delivery complete. ACK does not imply understanding or task completion. Branch navigation/compaction never rolls back broker state or auto-replays history.

## Availability and review

Stored sends report each recipient's observed presence and actual delivery state. Status derives attention for pending deliveries to unavailable/left recipients, open requests to unavailable participants even after delivery, and uncertain attempts. The widget shows persistent summary counts; status/inbox provide detail. No repeated blocking disconnect dialogs. On reconnect refresh pending counts immediately, not model execution. No expiry or overdue timer in this pilot; messages persist until explicit cancellation or history deletion.

Human review can keep waiting (no mutation), cancel a request, redirect within the same room, answer with explicit human attribution, or resolve a thread. Redirect retains the original message and marks the previous obligation redirected; the new recipient gets its own delivery. Late arrivals see current request/thread state and cannot silently reactivate cancelled/resolved/redirected obligations. Human answers are not protected decision approvals; decision tooling is not exposed.

## Privacy / limitations

Explicit peer messages delivered/read by an agent are sent to its configured model provider. No automatic transcript, prompt, environment, private file, credential, or hidden-reasoning sharing. Work summaries and artifact references are explicit opt-in text. Membership and message metadata persist locally, including the session binding. Runtime credentials are never committed.

No remote broker, dashboard, task board, spawning, merges, deployments, automatic activations, moderator grants, or approved-decision records in this slice. Broker stop is authenticated and preserves history. Backup/export/deletion operations and exact user command syntax are documented in `agent-coordination.md`.
