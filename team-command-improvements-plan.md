## Execution plan for Terra

### Scope

Strengthen the baseline without changing the public `/team` command set, tool schemas, storage locations, or default automation behavior.

Explicitly defer dashboards, autocomplete, configurable limits, multi-room support, decisions, and spawning.

---

## Phase 1 — Restore a trustworthy baseline

1. Run `npm ci`.
2. Confirm these resolve to `0.85.1`:
   - `@earendil-works/pi-ai`
   - `@earendil-works/pi-coding-agent`
   - `@earendil-works/pi-tui`
3. Run `npm run validate`.
4. Record any failures before changing production code.

The lockfile already specifies `0.85.1`; only `node_modules` is stale. Avoid changing dependency declarations unless a clean install demonstrates a real incompatibility.

**Checkpoint:** clean install and existing tests pass.

---

## Phase 2 — Add characterization tests

Before refactoring, lock down these invariants:

- Factory/startup remains side-effect-free until explicit join or reload restoration.
- Only exact-session reload restores enrollment.
- Busy, prompted, paused, or pending-input sessions never auto-dispatch.
- Broker claims do not imply Pi insertion.
- Uncertain execution never automatically replays.
- Control credentials never enter session content or tool schemas.
- Cross-room access remains rejected.
- Existing commands and tool results remain behaviorally unchanged.

Add two currently missing regression scenarios:

### Attention count overlap

Create a wake-eligible pending delivery whose recipient is offline while the room activation budget is exhausted. Assert:

- `automation.blocked === 1`
- `attention === 1`, not `2`

### Mixed persisted reservation

Reserve a batch containing:

- one message already proven in the session file
- one genuinely pending message

Assert that no model run begins until recovery semantics are implemented.

**Checkpoint:** characterization tests demonstrate the current edge cases without unrelated production changes.

---

## Phase 3 — Behavior-preserving extension decomposition

Refactor `extensions/coordination/index.ts` without changing its registered surface.

Suggested structure:

```text
extensions/coordination/
  index.ts          Extension composition and event registration
  runtime.ts        Binding, connection, heartbeat, refresh, shutdown
  commands.ts       /team parsing and command execution
  tools.ts          team_status, team_send, team_read registration
  rendering.ts      Widget and custom entry/message renderers
  constants.ts      entry/widget IDs and help text
```

Guidelines:

- Keep `index.ts` as the composition root.
- Centralize epoch/session fencing in `runtime.ts`.
- Expose narrow runtime methods such as `requireClient`, `join`, `leave`, `refresh`, and `shutdown`.
- Do not let command or tool modules manipulate sockets/timers directly.
- Preserve the existing rule that no resources start in the extension factory.
- Avoid introducing a general framework or dependency injection layer.
- Move existing extension tests first; add focused parser/runtime tests only where extraction makes them valuable.

**Checkpoint:** `npm run validate` passes with behavior-only refactoring.

---

## Phase 4 — Strengthen internal protocol typing

Replace stringly typed internal client calls with compile-time operation maps while retaining broker-side runtime validation.

Suggested shape:

```ts
interface WorkerOperations {
  status: { params: StatusParams; result: Status };
  send: { params: SendParams; result: Message };
  // ...
}

interface ControlOperations {
  join: { params: JoinParams; result: Credential };
  // ...
}
```

Then type `TeamClient.call()` by operation name and parameter/result mapping.

Requirements:

- Runtime validation in `TeamStore` remains authoritative.
- Do not expose control operations through agent tools.
- Avoid broad `Record<string, unknown>` at internal call sites.
- Test helpers may retain a lower-level untyped dispatch helper when deliberately testing malformed requests.
- Preserve wire protocol v1 and serialized request shapes.

Do not split `TeamStore` into independently transacting repositories. It must remain the sole transaction and authorization owner. Extract only cohesive helpers that operate inside its transaction boundary.

**Checkpoint:** invalid internal operation names/parameters fail at compile time; malformed wire input remains covered at runtime.

---

## Phase 5 — Correctness fixes

### A. Deduplicate attention accounting

Compute attention as a union of affected delivery IDs:

- uncertain delivery
- pending delivery/open obligation to an unavailable participant
- wake-eligible pending delivery blocked by the room budget

Do not add separate counts that may describe the same delivery. Keep `automation.blocked` as its own diagnostic field.

Add tests for:

- offline only
- budget-blocked only
- both conditions on one delivery
- multiple distinct affected deliveries

### B. Safely reconcile persisted items in a reserved batch

Introduce a host-only reservation reconciliation operation:

1. Automatic host reserves a batch.
2. Before dispatch, it checks persisted evidence for every message.
3. If evidence exists:
   - mark proven deliveries recorded
   - release untouched claims according to current obligation/thread state
   - cancel/refund that never-dispatched activation
   - do not pause the participant
   - do not trigger a model
4. Allow remaining eligible messages to be reserved normally afterward.
5. Evidence-read failures remain conservative and must not imply recording.

This should be atomic in `AutomationStore`.

Because this changes broker/extension activation semantics:

- Increment `ACTIVATION_POLICY_VERSION`.
- Treat policy versions 1 and 2 as known upgradeable predecessors.
- Ensure managed startup gracefully replaces a policy-2 broker without altering SQLite schema, credentials, history, or activation accounting.
- Preserve unknown future policies rather than replacing them.

Tests should cover:

- one persisted message
- mixed persisted/pending batch
- all messages persisted
- stale session/generation
- malformed or foreign evidence
- budget refund
- no participant pause
- no duplicate model wake
- upgrade from policy 2
- refusal to downgrade an unknown future policy

**Checkpoint:** focused automation, store, managed-startup, and SDK-loop tests pass.

---

## Phase 6 — Validation and handoff

Run:

```bash
npm run typecheck
npm run test
npm run validate
npm pack --dry-run
git diff --check
```

Also verify:

- no runtime coordination artifacts were created in Git
- no credentials appear in snapshots or fixtures
- schema remains version 2
- public commands/tools are unchanged
- documentation reflects activation policy 3 and the corrected recovery semantics

If Terra can operate two independent Pi terminals, repeat the documented live smoke test. Otherwise, clearly retain it as an unperformed manual verification rather than claiming completion.

## Recommended commit boundaries

1. `Restore coordination validation baseline`
2. `Add coordination invariant coverage`
3. `Decompose coordination extension runtime`
4. `Type coordination operations`
5. `Fix attention and persisted-batch recovery`
6. `Update coordination validation documentation`