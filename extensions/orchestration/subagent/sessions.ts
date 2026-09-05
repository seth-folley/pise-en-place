export const subagentSessionEntryType = "subagent-session";

export type SubagentSessionRun = {
    version: 1;
    parentSessionId: string;
    toolCallId: string;
    agent: string;
    task: string;
    childSessionId: string;
    sessionDir: string;
    startedAt: string;
    completedAt: string;
    exitCode: number;
    stopReason?: string;
};

type SessionEntry = {
    type?: unknown;
    customType?: unknown;
    data?: unknown;
};

function isSubagentSessionRun(value: unknown): value is SubagentSessionRun {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const run = value as Record<string, unknown>;
    return run.version === 1
        && typeof run.parentSessionId === "string"
        && typeof run.toolCallId === "string"
        && typeof run.agent === "string"
        && typeof run.task === "string"
        && typeof run.childSessionId === "string"
        && typeof run.sessionDir === "string"
        && typeof run.startedAt === "string"
        && typeof run.completedAt === "string"
        && typeof run.exitCode === "number";
}

/** Extract persisted child-session links from a parent Pi session. */
export function getSubagentSessionRuns(entries: unknown[]): SubagentSessionRun[] {
    return entries.flatMap((entry) => {
        const candidate = entry as SessionEntry;
        return candidate?.type === "custom" && candidate.customType === subagentSessionEntryType && isSubagentSessionRun(candidate.data)
            ? [candidate.data]
            : [];
    });
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Command that opens a retained child session in Pi without consulting normal session discovery. */
export function resumeSubagentSessionCommand(run: SubagentSessionRun): string {
    return `pi --session-dir ${shellQuote(run.sessionDir)} --session ${run.childSessionId}`;
}

export function formatSubagentSessionRuns(runs: SubagentSessionRun[]): string {
    if (!runs.length) return "No retained subagent sessions in this parent session yet.";
    return [
        `Retained subagent sessions (${runs.length})`,
        ...runs.map((run, index) => {
            const status = run.exitCode === 0 && run.stopReason !== "error" ? "completed" : "failed";
            return `${index + 1}. ${run.agent} — ${status}\n   ${resumeSubagentSessionCommand(run)}`;
        }),
    ].join("\n");
}
