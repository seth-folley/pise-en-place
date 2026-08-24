import { closeSync, openSync, writeSync } from "node:fs";

const AGENT = "pi";
const DEFAULT_TITLE = "Pi needs attention";
const TITLE_BYTE_BUDGET = 160;
const BODY_BYTE_BUDGET = 1000;
const WARN_INTERVAL_MS = 60_000;

let lastWarnedAt = 0;

type SupacodeNotificationContent = {
    title?: string;
    body: string;
};

function encodeNotificationField(value: string, byteBudget: number): string {
    const escaped = JSON.stringify(value).slice(1, -1);
    const bytes = Buffer.from(escaped, "utf8");
    const capped = bytes.length > byteBudget ? bytes.subarray(0, byteBudget) : bytes;
    return capped.toString("base64");
}

export function createSupacodeNotificationSequence(
    content: SupacodeNotificationContent,
): string {
    const title = encodeNotificationField(content.title ?? DEFAULT_TITLE, TITLE_BYTE_BUDGET);
    const body = encodeNotificationField(content.body, BODY_BYTE_BUDGET);
    const metadata = `kind=notify;title=${title};body=${body}`;
    return `\x1b]3008;start=${AGENT};${metadata}\x1b\\`;
}

function writeToTerminal(sequence: string): void {
    try {
        const descriptor = openSync("/dev/tty", "w");
        try {
            const bytes = Buffer.from(sequence, "utf8");
            let offset = 0;

            while (offset < bytes.length) {
                try {
                    const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
                    if (written <= 0) {
                        throw new Error(`short write (${offset}/${bytes.length} bytes)`);
                    }
                    offset += written;
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code;
                    if (code === "EINTR" || code === "EAGAIN") continue;
                    throw error;
                }
            }
        } finally {
            closeSync(descriptor);
        }
    } catch (error) {
        const now = Date.now();
        if (now - lastWarnedAt <= WARN_INTERVAL_MS) return;

        lastWarnedAt = now;
        const terminalError = error as NodeJS.ErrnoException;
        const code = terminalError.code ?? "";
        const errno = terminalError.errno ?? "";
        const message = terminalError.message ?? String(error);
        process.stderr.write(
            `supacode: attention notification failed: code=${code} errno=${errno} message=${message}\n`,
        );
    }
}

/**
 * Sends a rich notification to the current Supacode surface. Outside a
 * Supacode terminal this is intentionally a no-op.
 */
export function notifySupacodeAttention(body: string): void {
    if (!process.env.SUPACODE_SURFACE_ID) return;
    writeToTerminal(createSupacodeNotificationSequence({ body }));
}
