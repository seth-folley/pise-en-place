# Pi Agent Coordination — Requirements and Implementation Handoff

Status: Implementation brief, ready for a separate tooling agent. All implementation checkboxes start unchecked. Recommendations marked as such may be changed with rationale; changes to scope or authority require user approval.

## 1. Goal

Let independently running pi agents working on the same project exchange questions, proposals, handoffs, and blockers without the user manually copying messages between terminals. Provide a durable record of cross-agent decisions and an optional moderator with explicitly delegated authority.

Build a small coordination system, not an autonomous agent organization.

### First real use case

Two long-lived pi sessions develop a disc-golf app and its catalog backend in separate repositories or worktrees:

- **App agent:** iOS/TCA implementation, local inventory/bags/photos, catalog cache, chart integration.
- **Backend agent:** source feasibility, ingestion, catalog database, data quality, read-only catalog delivery.
- **Optional moderator:** contract disagreements, cross-agent dependencies, decision recording, and escalation.
- **User:** final authority on product requirements, permissions, infrastructure spending, and significant scope changes.

The app and backend need to coordinate catalog identity, flight-number representation, variants, missing values, versioning, and offline/update behavior. User data remains local to the app; coordination tooling does not change that requirement.

Success means a backend agent can ask the app agent a concrete contract question, receive an attributable response, resolve or escalate the issue, and leave a decision both agents can retrieve after restarting.

## 2. V1 scope

### Included

- Same-machine coordination between existing, independently launched pi sessions.
- Multiple repositories/worktrees associated with one explicitly joined coordination project.
- Pi extension tools and user-facing commands.
- A durable local messaging/decision service or equivalent cross-process mechanism.
- Named participants, roles, presence, inboxes, threads, replies, and handoffs.
- Controlled message delivery into agent context, including optional automatic wakeups.
- Human inspection, pause/resume, approval/rejection, and recovery controls.
- Optional moderation using a manually joined pi session; no automatic moderator spawning is required.
- Structured tests using fake agent adapters; a documented live two-session smoke test.

### Explicitly not included

- Automatic agent spawning, task decomposition, workforce management, or a general shared task board.
- Automatic commits, merges, deployments, scraping, purchases, or credential distribution.
- Cross-machine/cloud messaging, remote dashboards, accounts, or team authentication.
- Sharing complete session transcripts or hidden reasoning.
- Replacing Git, contract schemas, requirement documents, or integration tests with agent agreement.
- A security sandbox for mutually hostile processes running as the same OS user.
- An always-running LLM moderator that comments on every message.

## 3. Architecture and pi integration

Recommendation: **one extension in each pi session + a small per-user local broker with durable storage**. A local socket and SQLite are reasonable choices; the tooling agent may choose a simpler robust equivalent.

Keep deterministic transport/scheduling separate from LLM reasoning. Routing, authorization, retries, deduplication, and pause enforcement must not require model calls.

### Verified pi building blocks

The installed pi documentation provides:

- `pi.registerTool()` and `pi.registerCommand()` for extension interfaces.
- `pi.sendMessage()` for attributed custom messages in model context, with `steer`, `followUp`, and `nextTurn` delivery modes.
- Session lifecycle events and `agent_settled` for integrations tracking idle state.
- SDK sessions, event subscriptions, and message queueing if managed sessions are added later.
- An included `examples/extensions/subagent/` example for isolated parallel/chained delegation, not a complete persistent peer-coordination system.

Important constraints:

- `pi.events` is an extension event bus, not cross-process transport for unrelated terminals.
- Opening another session's JSONL file does not communicate with its running agent. Never append directly to another live session file.
- Inject peer messages as labeled custom messages, not as if the human typed them using `sendUserMessage()`.
- `agent_end` may precede retries, compaction, or queued continuation; it does not necessarily mean the session is settled.
- Defer connections, watchers, processes, and timers until `session_start` or an explicit command/tool. Factories may execute without any session starting.
- Clean up idempotently on `session_shutdown`, including reload/session replacement. Do not retain stale session-bound pi/context objects.
- Commands and SDK/runtime session replacement have different lifecycle constraints. Do not fork/switch sessions merely to deliver messages.
- Observe project trust before honoring project-local configuration. Do not expose environment secrets or full system prompts through registration/status.
- Dialog/UI behavior differs between TUI, RPC, JSON, and print modes. Unsupported approval UI must leave a request pending, not grant permission.
- Worktrees and tool allowlists are workflow boundaries, not complete security isolation; unrestricted bash can bypass simple path/tool conventions.

### Documentation handoff

The implementation agent must read its installed pi docs completely for the APIs it uses and follow relevant linked docs/examples before implementation. Do not rely on this brief's API notes instead of the current docs.

In this environment the package root is:

`/Users/seth/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/`

Relevant paths under that root:

- `README.md`
- `docs/extensions.md`
- `docs/sdk.md` if using SDK-managed sessions
- `docs/tui.md` for custom UI components
- `docs/session-format.md` for session entry inspection/recovery
- `docs/rpc.md` if supporting an RPC host integration
- `docs/packages.md` for distribution
- `examples/extensions/subagent/README.md`
- `examples/extensions/file-trigger.ts`, `message-renderer.ts`, and `event-bus.ts`

Resolve the installed package location on other machines; do not hardcode this Node version or home directory in the implementation.

## 4. Requirements

### Project membership and lifecycle

- [ ] **MEM-01 — Explicit enrollment.** A user joins a named coordination project and chooses a participant name/role. Sessions do not auto-discover and message arbitrary other sessions. Registration may be remembered, but automatic rejoin requires explicit opt-in.
- [ ] **MEM-02 — Cross-repository projects.** The same coordination project can contain participants with different cwd/repository/worktree paths. Project identity must not depend solely on cwd.
- [ ] **MEM-03 — Stable identity.** Assign immutable project/participant IDs and bind active connections to a concrete pi session ID plus connection generation. Display names are not authorization keys; conflicting names must not silently steal another participant's identity.
- [ ] **MEM-04 — Presence.** Show connected, working, idle, paused, waiting-for-user, and disconnected/unknown where observable. Use heartbeat/lease expiry for crashes. Distinguish observed runtime presence from an agent's self-reported work status.
- [ ] **MEM-05 — Replacement safety.** Reload can restore the same participant safely. `/new`, `/resume`, `/fork`, and `/clone` must not silently attach unrelated or duplicated sessions to an existing participant. Default to detach and require explicit rejoin when identity changes.
- [ ] **MEM-06 — Project isolation.** Participants can only address/read projects they have explicitly joined. Reject cross-project recipient/thread/decision IDs. Leaving stops delivery without deleting history.

### Messaging and threads

- [ ] **MSG-01 — Structured messages.** Support `question`, `reply`, `proposal`, `decision_request`, `handoff`, and `status`. Each has sender, recipient(s), project, thread, timestamp, body, and optional artifact references.
- [ ] **MSG-02 — Attributable delivery.** The service derives sender identity from registration, not an arbitrary model-supplied `from` field. Render author/role/type/thread clearly, and label content as peer-agent input rather than user authorization.
- [ ] **MSG-03 — Durable acceptance.** A successful send means the message has been durably stored. Return its ID immediately; do not block a sender's tool call until another LLM replies.
- [ ] **MSG-04 — Explicit lifecycle.** Distinguish stored, pending delivery, queued at recipient, recorded in recipient context, and explicitly acknowledged/resolved. None of these means the recipient understood or correctly acted on the content. Track delivery per recipient.
- [ ] **MSG-05 — Idempotent transport.** Use caller request IDs/idempotency keys and per-recipient message IDs. Retrying a send or reconnecting must not create duplicate logical messages. Document crash windows; do not claim exactly-once model execution.
- [ ] **MSG-06 — Threads and replies.** Link replies to message/thread IDs; preserve stable thread order through service-assigned sequencing. Concurrent replies must not overwrite each other. Reject invalid reply relationships.
- [ ] **MSG-07 — Offline recipients.** Retain messages for disconnected participants and expose pending/expired/cancelled states. Never claim a message reached a closed terminal. Reconnection and explicit reassignment must have documented behavior.
- [ ] **MSG-08 — Bounded context.** Paginate inbox/history and bound bodies/tool output. Suggested defaults: 16 KiB message bodies, 20 messages per page; tool output must respect pi's documented truncation limits and identify where omitted content can be retrieved.
- [ ] **MSG-09 — Artifact references.** Allow contract versions, repository+commit+path references, PR URLs, and test-result references. References do not automatically grant filesystem/network access or cause the broker to fetch arbitrary URLs/files.
- [ ] **MSG-10 — No broadcast noise.** Direct addressing is the default. Explicit project announcements may be supported, but must not automatically ask every agent to reply.

### Scheduling, responsiveness, and loop prevention

- [ ] **RUN-01 — Safe delivery boundaries.** Routine delivery waits until an appropriate boundary using supported pi APIs. It must not mutate an in-flight tool call or forcibly cancel ongoing local work.
- [ ] **RUN-02 — Wakeup policy.** Joining a project alone does not authorize unbounded model runs. Offer explicit automatic-wakeup opt-in. With it off, show notifications and deliver on user request/next turn without triggering a new run.
- [ ] **RUN-03 — Selective automatic wakeups.** When opted in, direct questions, decision requests, and replies to outstanding questions may trigger a bounded follow-up. Status, acknowledgments, and announcements do not trigger reply loops. Handoffs are informational unless explicitly accompanied by an authorized request to continue existing work.
- [ ] **RUN-04 — Urgent steering.** Make steering an explicit, restricted option rather than the default. Urgency cannot bypass pause, authority, rate limits, or user approval. A peer's urgent message is still peer input.
- [ ] **RUN-05 — No synchronous deadlocks.** Agents send questions and continue independent work or mark themselves blocked. They must not poll inboxes in an LLM loop or hold tool calls open waiting for each other.
- [ ] **RUN-06 — Loop and budget limits.** Bound automatic activations per thread and project over a time window, plus pending queue size. Suggested initial per-thread cap: four automatic activations, then pause that thread and surface an escalation. ACKs and presence events never wake a model. Only explicit human action resets an exhausted limit.
- [ ] **RUN-07 — Cost visibility.** Expose activation counts and token/cost information when available. Show unavailable cost as unknown, not zero. Do not promise a hard dollar cap unless the implementation can actually enforce one; deterministic activation limits are required regardless.
- [ ] **RUN-08 — Cancellation and recovery.** If a user aborts processing, do not immediately wake the agent again for the same message. Surface unresolved/uncertain delivery and allow deliberate retry. Recovery must not replay every historical message.

### Decisions and optional moderator

- [ ] **DEC-01 — Durable decision records.** Store a stable ID, question, proposal/options, rationale, evidence references, affected participants/artifacts, status, authority, and revision history. Preserve rejected/superseded proposals rather than rewriting history.
- [ ] **DEC-02 — Explicit states.** Distinguish proposed, awaiting input, awaiting human approval, accepted, rejected, withdrawn, and superseded. A normal chat response saying “agreed” does not silently accept a decision.
- [ ] **DEC-03 — Human authority by default.** Cross-agent decisions require user approval unless the user has explicitly delegated a bounded decision scope. Agents cannot grant themselves or other agents elevated authority through tools/messages.
- [ ] **DEC-04 — Optional moderator participant.** A user may designate a manually joined session as moderator. Moderator role and decision authority are separate: being the moderator does not automatically permit approving everything. The system remains useful with only two worker agents and the user.
- [ ] **DEC-05 — Bounded delegation.** Allow the user to delegate narrow coordination/technical choices within approved requirements/contracts. Persist and display the grant and its revocation. Moderator acceptance must cite the applicable grant and notify affected participants.
- [ ] **DEC-06 — Mandatory escalation.** Product/scope changes, permission changes, spending, credentials, deployment authorization, destructive actions, and changes outside delegated policy remain pending human approval. No majority vote or agent consensus overrides this boundary.
- [ ] **DEC-07 — Conflict handling.** Collect relevant worker input before resolving a cross-cutting disagreement, or explicitly surface unavailable input/timeouts to the user. A moderator may recommend an outcome without being authorized to accept it.
- [ ] **DEC-08 — Concurrency.** Require expected revision/version for state-changing decision operations. Reject stale approvals or conflicting updates without losing either participant's submitted input.
- [ ] **DEC-09 — Decision dissemination.** Accepted/rejected/superseded decisions notify affected participants and are queryable after restart. An approved decision does not automatically edit code, schemas, requirements, or Git history.
- [ ] **DEC-10 — Reviewable export.** Export a human-readable decision log suitable for checking into the owning repository on explicit request. Include IDs, status, authority, and exact artifact versions. Durable broker records remain separate from manually approved repository edits.

Authority enforcement must be deterministic for identity, roles, grants, and protected operations. Determining whether a subtle technical proposal really fits a natural-language delegation still requires judgment; document that limitation instead of presenting the moderator as a foolproof policy engine.

### User control and visibility

- [ ] **UX-01 — Inspectable status.** Provide a compact project/participant summary, unread/pending counts, blockers, pending approvals, and exhausted limits. Detailed message threads are available on demand, not dumped into every prompt.
- [ ] **UX-02 — Human commands.** Provide join/leave, status, inbox/thread inspection, decision review, pause/resume, and explicit retry/recovery operations. Exact syntax may differ from section 5 if documented.
- [ ] **UX-03 — Pause semantics.** Local pause prevents new automatic delivery/wakeups to that participant; project pause stops automatic delivery/wakeups project-wide. Persist pending messages. Pausing does not claim to abort an already running agent or undo a tool's side effects.
- [ ] **UX-04 — Approval provenance.** Human acceptance/delegation/revocation must come through an explicit user-facing control, not a worker-callable approve tool or a peer claiming “the user approved.” Missing UI/timeout means pending, not approved.
- [ ] **UX-05 — Interruptibility.** Normal pi abort/quit remains responsive. Coordination must not trap a session in polling, an unbounded wait, or repeated unsolicited dialogs. Provide a clear way to stop further automatic activations.
- [ ] **UX-06 — Appearance.** Support pi light/dark themes with semantic colors, clear textual statuses, and readable narrow-terminal output. Color alone must not communicate approval/error state. Fancy custom panels are optional.

### Privacy, reliability, and packaging

- [ ] **OPS-01 — Local-only default.** Bind only to a local socket or loopback transport, restrict storage/socket access to the current OS user, and reject unregistered clients. Never expose an unauthenticated LAN service.
- [ ] **OPS-02 — Minimal shared data.** Share only explicit messages, project metadata, artifact references, and decisions. Do not automatically transmit session history, hidden reasoning, API keys, environment variables, system prompts, or private app data. Warn users that message content delivered to an agent is sent to that agent's configured model provider.
- [ ] **OPS-03 — Content versus authority.** Peer text and referenced external material cannot change tool permissions, registration, delegation, or project membership merely by containing instructions. Enforce these at the service/extension boundary; document the same-OS-user trust limitation.
- [ ] **OPS-04 — Service failure isolation.** Broker unavailable/invalid payload/storage failure produces actionable errors, not false send success or a crashed pi session. The user can continue local coding without coordination.
- [ ] **OPS-05 — Recovery and migrations.** Use versioned protocol/storage formats. Handle broker restart, extension reload, simultaneous reconnects, and schema incompatibility without message loss or destructive automatic reset. A migration failure preserves the database.
- [ ] **OPS-06 — Inspectable operation.** Document service start/stop, storage location, health checks, backup/export, project deletion, and cleanup/uninstall. Deleting coordination history requires explicit confirmation.
- [ ] **OPS-07 — Reusable package.** Build outside the Ugly iOS app target, preferably in its own repository/package. No Disc Bag-specific assumptions in tooling. Document supported pi/Node versions and installation/reload steps; do not modify pi core.

## 5. Suggested interface

These names are a proposal, not pre-existing pi commands/tools. Keep the final interface small.

### User commands

```text
/team join <project> --name <name> --role <role>
/team leave
/team status
/team inbox
/team thread <id>
/team decisions
/team pause [local|project]
/team resume [local|project]
```

Decision review UI/commands handle human approval, delegation, revocation, thread-limit reset, explicit retry, and export. Avoid requiring users to type a large JSON payload.

### Agent tools

| Tool | Responsibility |
|---|---|
| `team_status` | Read project/participant status; optionally update only the caller's own work summary/blocker |
| `team_send` | Send an explicit message with recipient(s), type, body, thread/reply IDs, references, and idempotency key |
| `team_read` | Paginated inbox/thread/decision lookup; optionally acknowledge receipt without implying task completion |
| `team_decision` | Propose, contribute input, request resolution, or perform moderator-only acceptance within an existing user grant |

The worker tool schema must not offer human approval/delegation, arbitrary sender impersonation, arbitrary session prompting, or unrestricted shell execution inside the broker.

Tool descriptions should explain when to ask, when to continue independent work, how to cite evidence, and why not to poll or reply to status/ACK messages.

## 6. Data and delivery invariants

The implementation agent should publish a concise versioned protocol/schema before building both service and extension.

Minimum conceptual records:

- **Project:** immutable ID, display name, participant membership, limits/pause configuration.
- **Participant:** immutable ID, display name, role, current session binding/generation, presence, self-reported status, wakeup policy.
- **Thread:** project, participants, subject, status, automatic-activation budget.
- **Message:** immutable ID, service sequence, project/thread, sender, recipients, type/body, reply link, references, idempotency key, creation time.
- **Delivery:** message + recipient, state, attempt/generation, timestamps, error or uncertain outcome.
- **Decision:** ID, revision, proposal/input/rationale/evidence, affected parties/artifacts, state, authority reference, event history.
- **Authority grant:** user-origin record, recipient moderator, scope, lifecycle/revocation, timestamps.

Key invariants:

1. Durable send acceptance precedes delivery attempts.
2. Transport retries preserve logical message identity.
3. Delivery receipt is not semantic acknowledgment or task success.
4. Pi context insertion and broker acknowledgment are separate durability boundaries. A crash between them needs reconciliation or an explicit uncertain state, not a false exactly-once guarantee.
5. History and decisions survive compaction/restart without reinjecting the entire history. Fetch relevant summaries/records on demand.
6. Session forks/tree navigation do not roll back external decisions or resend previously emitted messages merely because local context changed.
7. No automatic activation occurs while paused, disallowed, or over budget.
8. Approval/authority updates and stale-decision checks are serialized transactionally.
9. Peer messages never acquire the authority of a human instruction solely because the transport delivered them.

## 7. Acceptance scenarios

Use deterministic fake pi/session adapters, clocks, and temporary storage for automated tests. No live LLM/network credentials should be needed for the automated suite. Use manual terminal walkthroughs rather than introducing a UI/snapshot test suite.

- [ ] **AT-01 — Two-repo question/reply.** Two independently running sessions join one project from different repositories. App asks a contract question; backend receives it with correct attribution and replies in the same thread; app receives the reply without copy/paste.
- [ ] **AT-02 — Offline delivery.** Recipient disconnects; sender receives durable-storage success but not delivered success. Reconnecting the correct participant receives pending work once logically; another project/session does not.
- [ ] **AT-03 — Busy delivery.** A question sent while the recipient is executing tools queues safely. With wakeups disabled it does not start a new model run. With permitted wakeups enabled it runs at the configured boundary.
- [ ] **AT-04 — Retry/crash windows.** Repeat an idempotent send, reconnect during delivery, and crash after context insertion before receipt acknowledgment. No duplicate logical messages; uncertain outcomes are visible and safely recoverable.
- [ ] **AT-05 — Lifecycle isolation.** Reload preserves identity without duplicate listeners/delivery. Fork/new/resume/clone does not silently reuse or hijack the prior participant binding. Crashed participants eventually appear disconnected.
- [ ] **AT-06 — Pause and abort.** Pause locally/project-wide, send more messages, and confirm no forbidden wakeups. Abort a message-triggered run and confirm it is not immediately restarted automatically. Resume/retry is deliberate.
- [ ] **AT-07 — Loop protection.** Simulated agents repeatedly reply to each other. The configured activation limit stops the exchange and surfaces escalation. Status/ACK/presence events never create new model calls.
- [ ] **AT-08 — Human decision.** Workers propose incompatible catalog representations. Both inputs appear in one decision; user accepts a specific revision; both receive the same immutable accepted outcome. A stale approval is rejected.
- [ ] **AT-09 — Moderator boundaries.** With an explicit grant, moderator resolves an allowed coordination issue. Worker self-approval, forged human approval, revoked grants, and protected spending/product/permission decisions cannot bypass human review.
- [ ] **AT-10 — No moderator.** Two workers can exchange messages and request human resolution without a moderator process. A disconnected moderator never causes indefinite synchronous tool waits.
- [ ] **AT-11 — History recovery.** Restart service and sessions, compact or navigate a session branch, then retrieve accepted/superseded decisions and their artifact versions. No automatic replay of every old message or rollback of external records.
- [ ] **AT-12 — Validation/privacy.** Reject oversized payloads, invalid types/IDs/reply links, cross-project lookups, unauthorized approval operations, and incompatible protocol versions. Status does not leak prompts, keys, unrelated sessions, or private files.
- [ ] **AT-13 — Failure containment.** Test unavailable broker, unwritable storage, migration error, malformed response, expired lease, and queue saturation. Report honest errors while pi remains usable for local coding.
- [ ] **AT-14 — Inspectability.** Human can inspect pending questions, blockers, decisions, authority, delivery uncertainty, and limits in both themes. Headless contexts cannot accidentally auto-approve UI requests.
- [ ] **AT-15 — Reusable install.** A clean documented install can connect two pi sessions without modifications to pi core or the Ugly app. Uninstall/stop leaves sessions usable and preserves or explicitly removes data as requested.

## 8. Suggested implementation slices

Keep this work independent of app/backend implementation. Do not implement either product while building the coordination tool.

1. **Protocol and authority design:** settle storage/transport, IDs, delivery semantics, user controls, and tool schemas. Document intentional limitations.
2. **Broker foundation:** durable project/membership/message records, leases, idempotency, project isolation, protocol validation, and fake-client tests.
3. **Two-session extension:** explicit join, tools, notifications/inbox, safe custom-message delivery, reload/reconnect handling, and wakeups off by default.
4. **Controlled automation:** opt-in follow-ups, pause/abort handling, loop budgets, and delivery reconciliation tests.
5. **Decision workflow:** human review first; optional manually joined moderator with explicit grants; revision control and export.
6. **Packaging and pilot:** setup/recovery docs, live app/backend-style smoke test, and completion report mapped to requirement/acceptance IDs.

First useful milestone: two existing terminals exchange a durable, attributable question/reply with manual delivery and no moderator. Do not wait for advanced moderation to validate the communication path.

## 9. Required handoff back to the app agent

When the tooling is ready, provide:

- Repository/package location, version/commit, and supported pi/Node versions.
- Exact installation, service startup, extension reload, and join instructions.
- Actual tool/command names and schemas, including how this already-running session should connect.
- How to create/join one project across the app and backend repositories.
- Storage location, privacy boundaries, wakeup defaults, authority model, and pause/stop/recovery instructions.
- Completed requirement/acceptance IDs and automated test results.
- Live two-session smoke-test result, known limitations, and any manual setup still required.
- If applicable, moderator setup and a sample narrow delegation policy.

Do not report tooling as installed or available in this app session merely because its files were created elsewhere. The user will return here once installation/reload is ready; this session should first inspect the actual available tools and join explicitly.

## 10. Kickoff prompt for the tooling agent

> Build the reusable pi coordination extension/tooling described in `PiAgentCoordinationRequirements.md`. Work in a separate tooling repository, not the Ugly iOS package. Start by reading the installed pi documentation and proposing the smallest robust protocol, delivery semantics, and authority design. Implement durable two-session messaging before moderation. Use deterministic tests without live model credentials, preserve pi's normal lifecycle/abort behavior, and do not add automatic spawning/merging/deployment. Treat human approval and bounded moderator delegation as explicit authority boundaries. Finish with the installation and integration handoff listed in section 9 so the existing app agent can connect later.
