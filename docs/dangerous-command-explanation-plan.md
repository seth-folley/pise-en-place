# Dangerous Command Explanation Flow Plan

## Goal

Enhance `extensions/confirm-dangerous-operations.ts` so dangerous bash commands can be handled with three user choices:

1. **Allow once**
2. **Block**
3. **Ask agent to explain why**

If the user has already requested an explanation for the same normalized command during the current extension runtime/session, the confirmation UI should mention that fact so the user can review the transcript before allowing it.

## Proposed behavior

### First dangerous command attempt

For a command such as:

```sh
rm -rf build
```

The extension detects hazards and presents a selection UI similar to:

```text
Allow potentially dangerous bash command?

Hazards:
• file deletion

Command:
rm -rf build

Options:
- Allow once
- Block
- Explain
```

If the user selects **Explain**, block the tool call with a reason instructing the agent to explain before retrying using a parseable fenced Markdown block.

Example block reason:

````text
Blocked pending explanation.

Before retrying this command, respond using exactly this format:

```dangerous-command-explanation
tools: <comma-separated command-line programs invoked by the bash command, such as rm, git, gh, curl, or docker; do not list the Pi bash tool itself>
description: <plainly describe the effect of this tool call, without mentioning the tool or command name and without explaining why it is used>
reason: <the actual reason for using this tool call>
risk: <low|medium|high|extreme>
```

Use exactly these four keys. Keep each value on a single line. Do not retry the command until the user explicitly approves.
````

### Retry after explanation request

If the same normalized command is attempted again during the current runtime/session and a formatted explanation was captured, include the previous explanation in the prompt.

If an explanation was requested but no formatted explanation was captured, include a note that no formatted explanation is available yet.

The user still chooses allow/block/explain again. The extension should not auto-allow after an explanation request.

## Scope

Implement this for dangerous **bash** commands first.

For dangerous `write` / `edit` operations against protected paths, keep the current allow/block confirmation behavior for v1. They can be extended later with a similar operation-key cache if useful.

## Data model

Use an in-memory map keyed by normalized command string:

```ts
type ExplanationRequest = {
    command: string;
    normalizedCommand: string;
    reasons: string[];
    requestedAt: number;
    count: number;
    explanation?: string;
    explainedAt?: number;
};

const explanationRequests = new Map<string, ExplanationRequest>();
```

This state is runtime/session-local. Do not persist it for v1.

## Command normalization

Use conservative normalization only:

```ts
function normalizeCommandKey(command: string): string {
    return command.replace(/\r\n?/g, "\n").trim();
}
```

This handles line ending differences and outer whitespace without attempting to parse shell syntax or collapse meaningful internal whitespace.

## Helper functions

Add helpers along these lines:

```ts
function getExplanationRequest(command: string): ExplanationRequest | undefined;
function recordExplanationRequest(command: string, reasons: string[]): void;
function pruneExplanationRequests(maxAgeMs = 60 * 60 * 1000): void;
```

Pruning is optional but recommended to avoid unbounded memory growth.

## UI/API shape

Replace the bash confirmation boolean path with an action-returning flow:

```ts
type DangerousOperationAction = "allow" | "block" | "explain";
```

Add a bash-specific chooser:

```ts
async function chooseDangerousCommandAction(
    command: string,
    reasons: string[],
    ctx: ExtensionContext,
): Promise<DangerousOperationAction>;
```

This should use a multi-option UI such as `ctx.ui.select()` rather than `ctx.ui.confirm()`.

Non-UI mode should remain fail-closed and return `"block"`.

## Bash tool flow

Current flow:

```ts
const allowed = await confirmDangerousCommand(command, reasons, ctx);
if (allowed) return undefined;

return { block: true, reason: blockedOutput(reasons) };
```

New flow:

```ts
const action = await chooseDangerousCommandAction(command, reasons, ctx);

if (action === "allow") return undefined;

if (action === "explain") {
    recordExplanationRequest(command, reasons);
    return { block: true, reason: explanationRequestOutput(reasons) };
}

return { block: true, reason: blockedOutput(reasons) };
```

Use the same flow for `user_bash`, adapting the return shape to the existing `user_bash` result object.

## Output helpers

Keep existing blocked output:

```ts
function blockedOutput(reasons: string[]): string;
```

Add:

```ts
function explanationRequestOutput(reasons: string[]): string;
```

It should include the hazard labels and the explicit explanation checklist.

## Explanation text capture

Capture the next assistant message after an explanation request only if it includes a fenced block tagged `dangerous-command-explanation`.

For v1, extract and cache the full fenced block rather than parsing individual fields. The extension should not claim the explanation is verified; it should only display it as the previous captured explanation.

## Manual test cases

1. Safe command runs without prompt:

   ```sh
   echo hello
   ```

2. Dangerous command prompts:

   ```sh
   rm -rf build
   ```

3. Select **Block** → command is blocked with the existing blocked message.

4. Select **Allow once** → command runs.

5. Select **Explain** → command is blocked with formatted explanation instructions.

6. Agent responds with a `dangerous-command-explanation` fenced block.

7. Retry the same command → dialog includes the captured previous explanation.

7. Retry with outer whitespace:

   ```sh
     rm -rf build  
   ```

   It should match the same normalized key.

8. Non-UI mode remains fail-closed.

## Known limitations

- The cache is in-memory only and is lost on extension reload/session restart.
- The extension captures formatted explanations, but does not verify their quality or correctness.
- Similar explain behavior for `write` / `edit` is intentionally out of scope for v1.
