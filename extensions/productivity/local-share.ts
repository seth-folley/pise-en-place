import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { mkdir, stat } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function sanitizeFilePart(value: string): string {
    return value
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
}

function timestampForFileName(date = new Date()): string {
    return date.toISOString().replace(/[:.]/g, "-");
}

function getGlobalPiDir(): string {
    return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function getOutputPath(cwd: string, sessionId: string, args: string): string {
    const trimmedArgs = args.trim();
    if (trimmedArgs) {
        const requestedPath = trimmedArgs.endsWith(".html") ? trimmedArgs : `${trimmedArgs}.html`;
        return isAbsolute(requestedPath) ? requestedPath : resolve(cwd, requestedPath);
    }

    const transcriptDir = join(getGlobalPiDir(), "sessions", "transcripts");
    const sessionPart = sanitizeFilePart(sessionId) || "session";
    return join(transcriptDir, `${timestampForFileName()}-${sessionPart}.html`);
}

function terminalHyperlink(text: string, url: string): string {
    return `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`;
}

export default function (pi: ExtensionAPI) {
    pi.registerCommand("share-local", {
        description: "Export the current session to local HTML and show an openable file link",
        handler: async (args, ctx) => {
            await ctx.waitForIdle();

            const sessionFile = ctx.sessionManager.getSessionFile();
            if (!sessionFile) {
                ctx.ui.notify("Cannot export an in-memory session.", "error");
                return;
            }

            const absolutePath = resolve(getOutputPath(ctx.cwd, ctx.sessionManager.getSessionId(), args));

            try {
                await mkdir(dirname(absolutePath), { recursive: true });

                // Use the CLI contract, not a private module from whichever npm copy resolves here.
                // Export exits before agent/resource startup; disable discovery defensively as well.
                const result = await pi.exec("pi", [
                    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
                    "--export", resolve(sessionFile), absolutePath,
                ], { cwd: ctx.cwd });
                if (result.killed || result.code !== 0) {
                    const reason = result.killed ? "Pi export process was terminated." : `Pi export exited with code ${result.code}.`;
                    const diagnostic = stripVTControlCharacters(result.stderr).trim();
                    const guidance = !diagnostic && !result.killed ? "Ensure the pi executable is available on PATH." : undefined;
                    throw new Error([reason, diagnostic, guidance].filter(Boolean).join("\n"));
                }
                const output = await stat(absolutePath);
                if (!output.isFile() || output.size === 0) {
                    throw new Error("Pi export did not produce a non-empty HTML file.");
                }
                const fileURL = pathToFileURL(absolutePath).href;
                const link = terminalHyperlink(basename(absolutePath), fileURL);

                ctx.ui.notify(`Local transcript created: ${link}\n${fileURL}`, "info");
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                ctx.ui.notify(`Failed to create local transcript: ${message}`, "error");
            }
        },
    });
}
