# Absolute-token automatic compaction

`extensions/productivity/autocompact/` adds an opt-in compaction strategy and an agent-callable `compact_context` tool. Requires Pi **0.87.1 or newer**.

## Commands

```text
/autocompact                     Show status, current usage, and effective thresholds
/autocompact status              Same status report (explicit form)
/autocompact on                  Enable this strategy
/autocompact off                 Disable this strategy
/autocompact ceiling 250000      Set the absolute ceiling (positive integer)
```

Argument autocomplete offers `status`, `on`, `off`, and `ceiling` with descriptions, filtered by the prefix you type. Enter the numeric token limit after `ceiling`.

The default ceiling is **250,000 tokens**, across all models. The strategy starts **disabled**. Changing the ceiling does not implicitly enable it.

Configuration is saved atomically in `<agent-dir>/autocompact.json` (normally `~/.pi/agent/autocompact.json`):

```json
{
  "enabled": true,
  "ceilingTokens": 250000
}
```

This is package-owned configuration, not Pi's `compaction` settings. It contains no conversation content. Settings load at session startup/reload and when `/autocompact` runs; other open sessions do not hot-reload changes. Invalid configuration disables this strategy on startup and is not silently overwritten.

## Thresholds

For the default ceiling on a sufficiently large model:

| Threshold | Tokens | Action |
|---|---:|---|
| 80% | 200,000 | Informational warning: continue normally; no compaction call or note needed. |
| 90% | 225,000 | Continue normally; manual compaction is optional at a natural stopping point. |
| 100% | 250,000 | Summarize older context at the completed-turn boundary. |

Warnings are percentages of the **effective ceiling**, not the full model window. A smaller model uses `min(configured ceiling, context window − reserve)`, where reserve is the smaller of 16,384 tokens or 20% of its window (rounded up). For a 128,000-token model, the effective ceiling is 111,616.

Each warning fires once per compaction cycle; jumping across both warning thresholds produces only the stronger warning. Successful compaction resets warnings. Session/branch/model changes also reset threshold tracking. Unknown context usage is not treated as zero.

Checks run after an assistant response and all its tool results are persisted, before the next response. A final answer can trigger compaction without creating another assistant response. Warning messages enter model context without forcing continuation; notifications appear when a UI is available.

**This is a trigger, not a hard request-size or price cap.** A large new user prompt, tool batch, or queued message can overshoot it. There is no preflight interception of every provider request. Summarization itself is a model request and may also cross a provider's pricing threshold. Leave headroom below the pricing boundary you care about.

## Footer indicator

The Dracula and minimal footers show **≡** immediately after the context bar:

- **Green**: enabled, below 80% of the effective compaction ceiling.
- **Yellow**: at or above 80%.
- **Red**: at or above 90%, including over-ceiling usage.
- **Dim**: this strategy is disabled.
- **Accent color**: enabled, but current usage is unknown (for example, just after compaction).

The bar still measures the model's context window; the symbol measures this strategy's **effective ceiling**. Its color uses live usage, not a retained pre-compaction estimate. Configuration changes repaint the indicator immediately. If the autocompact extension is not loaded, the symbol is omitted.

Use `/autocompact status` for current tokens, percentage of the effective ceiling, configured/effective ceilings, and both warning limits. Bare `/autocompact` shows the same report.

## Agent tool

```json
{
  "instructions": "Preserve the migration decision and changed file paths.",
  "note": "Next: rerun the auth tests after fixing the mock clock. Implementation is done but unverified. Do not change the public API."
}
```

Call this with `compact_context`. Agent guidance favors continuing the task and letting enabled automatic compaction handle the ceiling. Manual use is for a user request or, optionally, a natural stopping point after a 90% warning—not simply a long conversation, task completion, or a desire to leave a note. This is guidance, not a minimum-token execution gate.

Both fields are optional:

- **`instructions`** guides what the summarizer should preserve (up to 8,000 characters).
- **`note`** is a short note to the next assistant, appended **verbatim after the generated summary** under `## Agent handoff note` (up to 1,000 characters). Use concrete working state: the next action, unfinished verification, or important constraints—not a reasoning transcript.

The tool queues compaction until **all tools in the current batch finish**; its result acknowledges the request, not completion. Parallel requests coalesce: instruction and note limits apply to their combined text, including blank-line separators. An over-limit request is rejected without discarding previously accepted requests. Blank notes are ignored. The tool works even when automatic thresholds are disabled.

The 80%/90% warnings do not ask the agent to prepare a note or interrupt useful work. A note is optional when compaction is already warranted; automatic compaction never requires one. Notes are not separately stored in a ledger or configuration file: they live in the ordinary session transcript and successful compaction summary. A fresh note bypasses the summarizer and counts toward post-compaction context limits. On the next compaction, the previous note becomes historical summary input; the summarizer is instructed to reconcile it with subsequent work rather than accumulate stale handoff sections. Failed or cancelled compaction does not append a note; a retry must supply it again.

Pi's ordinary scheduler continues the task after compaction. The extension does not abort successful runs, inject synthetic continuation prompts, or reorder steering/follow-up queues.

## Summary and retention

The current model generates a structured summary covering goals, constraints, progress, decisions, next steps, critical context, and files. Previous summaries participate in subsequent summarization. Pi's projected context is used, so omitted entries stay omitted and replacements are respected.

The strategy targets **20,000 recent tokens retained verbatim**, reducing that budget to 40% of the effective ceiling on small budgets. Cuts occur at user/assistant boundaries; tool calls stay with their results. The summary output budget is at most 8,192 tokens, also limited by the model output limit and 20% of the effective ceiling. Tool results in the summarized prefix use Pi's serializer, which truncates each result to 2,000 characters. Compaction is lossy; keep important details in preservation instructions or durable project files.

The summary is committed as a native compaction entry, with its model usage, through Pi's turn-boundary API. The original transcript is not deleted. The system prompt and tool definitions remain managed by Pi. Summary requests disable prompt-cache retention.

If summarization fails, produces an empty/truncated result, cannot retain a complete tool batch, or leaves the estimated context above the ceiling, the run pauses without committing a compaction. Use `/compact` to retry, change the ceiling, or disable the strategy. Cancellation does not commit a partial summary. Automatic attempts do not loop while context remains over budget; an explicit tool request can retry.

## Relationship to native Pi compaction

Pi's native threshold/overflow handling and manual `/compact` remain unchanged. They can compact earlier, particularly on smaller models or with custom native reserves. `/autocompact off` disables **only this package's automatic policy**, not native Pi compaction or the `compact_context` tool.

This strategy has its own summary/retention policy; Pi's `compaction.keepRecentTokens`, `reserveTokens`, and `modelOverrides` still govern native compaction, not this strategy. Package boundary compactions do not invoke Pi's `session_before_compact` customization hook or its `session_compact` lifecycle event. Their persisted compaction entries and usage are available through the session history and entry events.
