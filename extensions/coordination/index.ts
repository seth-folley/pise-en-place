import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTeamCommand } from "./commands.ts";
import { registerCoordinationRenderers } from "./rendering.ts";
import { CoordinationRuntime } from "./runtime.ts";
import { registerTeamTools } from "./tools.ts";

export default function coordination(pi: ExtensionAPI) {
    const runtime = new CoordinationRuntime(pi);

    registerCoordinationRenderers(pi);
    registerTeamTools(pi, runtime);
    registerTeamCommand(pi, runtime);

    pi.on("session_start", (event, context) => runtime.sessionStart(event, context));
    pi.on("session_shutdown", () => runtime.shutdown());
    pi.on("agent_start", (event, context) => runtime.agentStarted(context, context.signal));
    pi.on("agent_end", (event, context) => runtime.agentEnded(context, event.messages));
    pi.on("agent_settled", (_event, context) => runtime.agentSettled(context));
    pi.on("ui_prompt_start", (_event, context) => runtime.promptStarted(context));
    pi.on("ui_prompt_end", (_event, context) => runtime.promptEnded(context));
}
