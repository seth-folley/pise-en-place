import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";

/**
 * ctrl+shift+x — Copy the current editor input to the clipboard, then clear it.
 * Useful for preserving a draft before abandoning or restarting a prompt.
 */
export default function (pi: ExtensionAPI) {
	pi.registerShortcut("ctrl+shift+x", {
		description: "Copy current input to clipboard and clear editor",
		handler: async (ctx) => {
			const text = ctx.ui.getEditorText();

			if (!text) {
				ctx.ui.notify("Editor is empty", "info");
				return;
			}

			await copyToClipboard(text);
			ctx.ui.setEditorText("");

			ctx.ui.notify("Input cut to clipboard", "info");
			ctx.ui.setStatus("cut-input", "✂ Input cut to clipboard");
			setTimeout(() => ctx.ui.setStatus("cut-input", undefined), 2000);
		},
	});
}
