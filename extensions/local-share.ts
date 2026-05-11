import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type ExportSessionToHtml = (
    sessionManager: unknown,
    state?: unknown,
    options?: { outputPath?: string; themeName?: string }
) => Promise<string>;

const require = createRequire(import.meta.url);

function getPackageDistDir(): string {
    try {
        return dirname(require.resolve("@mariozechner/pi-coding-agent"));
    } catch {
        // Project-local extensions may not have pi in local node_modules. In normal pi runs, argv[1] points at
        // pi's CLI entrypoint, so resolve that symlink and use its dist directory instead.
        return dirname(realpathSync(process.argv[1]));
    }
}

async function loadExportSessionToHtml(): Promise<ExportSessionToHtml> {
    const exportModulePath = join(getPackageDistDir(), "core", "export-html", "index.js");
    const exportModule = await import(pathToFileURL(exportModulePath).href) as {
        exportSessionToHtml: ExportSessionToHtml;
    };

    return exportModule.exportSessionToHtml;
}

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

            const outputPath = getOutputPath(ctx.cwd, ctx.sessionManager.getSessionId(), args);

            try {
                await mkdir(dirname(outputPath), { recursive: true });

                const exportSessionToHtml = await loadExportSessionToHtml();
                const filePath = await exportSessionToHtml(ctx.sessionManager, undefined, { outputPath });
                const absolutePath = resolve(filePath);
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
