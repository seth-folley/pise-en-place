import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerShortcut("alt+s", {
		description: "Copy current session ID",
		handler: async (ctx) => {
			const id = ctx.sessionManager.getSessionId();
			await copyToClipboard(id);

			ctx.ui.notify(`Copied session ID: ${id}`, "info");
			ctx.ui.setStatus("copy-session-id", `Session ID copied: ${id}`);
			setTimeout(() => ctx.ui.setStatus("copy-session-id", undefined), 2000);
		},
	});
}
