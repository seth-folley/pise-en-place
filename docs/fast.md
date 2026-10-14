# OpenAI Fast mode

Requires Pi 1.2.0 or newer. After installing this package or changing its extension code, run `/reload`.

- `/fast` or **Alt+Shift+F** toggles activation.
- `/fast on` requests priority service for the current session and selected model.
- `/fast off` stops this extension requesting priority service.
- `/fast status` reports activation and connection compatibility without changing state.

On shutdown/reload, the extension removes provider wrappers it still owns; another extension's replacement is left untouched. After reload, fast mode can be enabled again normally.

Fast mode **always starts off**. Activation is held only in memory: no settings file or custom session entry is written. New sessions, resume, forks, reload, tree navigation, and provider/model changes reset it. Returning to a previously enabled model does not reactivate it. Thinking-level changes alone do not reset activation or change the reasoning effort.

Commands and the Alt+Shift+F shortcut that change activation wait until the current run is idle. The shortcut dispatches `/fast` without changing the editor input or sending a prompt to the model. If the session or model changes while waiting, the command leaves the state unchanged and asks you to run it again when a live context is still available. A pending command from an unloaded runtime is cancelled without touching its invalidated context.

## Availability and indicator

Only native `openai` with OpenAI Responses and `openai-codex` with Codex Responses are supported. Requests must target the native HTTPS OpenAI API or ChatGPT Codex endpoint. Other providers, custom proxies, virtual models, Chat Completions, and OpenAI provider registrations owned by another extension are excluded. The extension will not replace another extension's provider registration. If its wrapper is replaced later, activation is reset when the next agent run starts or `/fast status` checks it; it can be enabled again only when the native provider is available. `/fast` remains visible because Pi does not offer conditional command visibility or command removal; unsupported activation produces an explanation.

When enabled, Dracula and minimal footers show highlighted **`⚡ fast`** immediately after model/thinking:

```text
π · gpt-6.1-sol medium ⚡ fast · branch
```

The indicator means **priority requested**, not confirmed priority allocation or guaranteed acceleration. With `/statusline` off, this extension does not add a replacement footer or widget. `/fast status` remains available.

Compatibility is not account entitlement: the provider may reject priority for a particular model or account. Enabling warns that additional cost/usage may apply. For recognizable priority-rejection errors, the extension suggests `/fast off` before retrying; it preserves the original error and does not add automatic retries or silently downgrade. Pi's existing transport recovery/retry behavior is unchanged.

## Request and usage behavior

The extension lazily wraps the existing native provider on first activation, preserving its authentication, catalog, filters, classifier support, and native request implementation. Disabled requests delegate to its original `streamSimple` unchanged.

Pi 1.2.0's simple-options conversion drops `serviceTier`. Enabled requests therefore use Pi's exported simple-options and thinking-level conversion helpers, then delegate to the provider's native `stream` with `serviceTier: "priority"`. This lets the native HTTP/WebSocket request builders send `service_tier` and lets the same implementation account for the service tier. No independent price multiplier is applied by this extension.

Activation applies only while the agent is running, for this session's selected physical model and requests with its exact session routing ID. Idle auxiliary requests such as bug-report summaries and cache warming do not inherit priority. Compaction, summaries, and separate nested-model calls with other or absent routing IDs are unaffected. Disabling does not override a service tier configured independently elsewhere.

Native Pi pricing is an estimate, not an account-usage bill. In Pi 1.2.0, Codex treats `default` or an omitted response tier as the requested priority tier for cost accounting; OpenAI API Responses honors an explicit `default` response tier and falls back to the request tier when omitted. Those native conventions are retained, not interpreted as proof of acceleration.

Offline tests exercise both native Codex transports, request preservation, OpenAI/Codex tier accounting, footer lifecycle, and real SDK command/provider integration. No live priority requests are required by the test suite.
