/** Usage facts come only from raw, append-only session entries, never projected context or nested tool hooks. */
export type UsageKind = "assistant" | "tool_result" | "compaction" | "branch_summary" | "usage";
export type AccountedUsage = {
    input: number; output: number; cacheRead: number; cacheWrite: number;
    totalTokens: number; totalCost: number | null;
};
export type SessionUsageFact = {
    sessionEntryId: string;
    timestamp: string;
    kind: UsageKind;
    usageKind?: string;
    provider: string | null;
    model: string | null;
    api: string | null;
    usage: AccountedUsage;
};

function object(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
function timestamp(value: unknown): string | undefined {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function normalizeAccountedUsage(value: unknown): AccountedUsage | undefined {
    const raw = object(value);
    if (!raw) return undefined;
    const input = raw.input ?? 0, output = raw.output ?? 0;
    const cacheRead = raw.cacheRead ?? 0, cacheWrite = raw.cacheWrite ?? 0;
    const values = [input, output, cacheRead, cacheWrite];
    if (!values.every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)) return undefined;
    // reasoning and cacheWrite1h are subsets, not extra tokens. Match Pi's session totals.
    const totalTokens = (input as number) + (output as number) + (cacheRead as number) + (cacheWrite as number);
    if (!Number.isFinite(totalTokens)) return undefined;
    const cost = object(raw.cost)?.total;
    return {
        input: input as number, output: output as number, cacheRead: cacheRead as number, cacheWrite: cacheWrite as number,
        totalTokens, totalCost: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
    };
}

/** Deduplicate entry identities, not equal usage amounts: distinct calls can have identical usage. */
export function collectSessionUsage(entries: readonly unknown[]): SessionUsageFact[] {
    const seen = new Set<string>();
    const facts: SessionUsageFact[] = [];
    for (const value of entries) {
        const entry = object(value), id = text(entry?.id);
        if (!entry || !id || seen.has(id)) continue;
        const message = object(entry.message);
        let kind: UsageKind;
        let source: Record<string, unknown>;
        if (entry.type === "message" && (message?.role === "assistant" || message?.role === "toolResult")) {
            if (message.role === "assistant" && message.stopReason === "pending") continue;
            kind = message.role === "assistant" ? "assistant" : "tool_result";
            source = message;
        } else if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "usage") {
            kind = entry.type;
            source = entry;
        } else continue;
        const usage = normalizeAccountedUsage(source.usage);
        const time = timestamp(source.timestamp) ?? timestamp(entry.timestamp);
        if (!usage || !time) continue;
        seen.add(id);
        const attributed = kind === "assistant" || kind === "usage";
        facts.push({
            sessionEntryId: id, timestamp: time, kind,
            ...(kind === "usage" && typeof entry.kind === "string" ? { usageKind: entry.kind } : {}),
            // Tools/summaries have no canonical model attribution. Do not guess from the currently selected model.
            provider: attributed ? text(source.provider) : null,
            model: attributed ? text(source.responseModel) ?? text(source.model) : null,
            api: attributed ? text(source.api) : null,
            usage,
        });
    }
    return facts;
}

export function totalSessionUsage(entries: readonly unknown[]): Omit<AccountedUsage, "totalCost"> & { totalCost: number; records: number; costedRecords: number } {
    const facts = collectSessionUsage(entries);
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, totalCost: 0, records: facts.length, costedRecords: 0 };
    for (const { usage } of facts) {
        totals.input += usage.input;
        totals.output += usage.output;
        totals.cacheRead += usage.cacheRead;
        totals.cacheWrite += usage.cacheWrite;
        totals.totalTokens += usage.totalTokens;
        if (usage.totalCost !== null) { totals.totalCost += usage.totalCost; totals.costedRecords++; }
    }
    return totals;
}

/** Live-only capture: baseline copied/resumed entries, serialize writes, and retry failed writes on reconciliation. */
export class LiveUsageCapture {
    private readonly seen: Set<string>;
    private pending: Promise<void> = Promise.resolve();
    private readonly writes = new Map<string, () => Promise<void>>();
    private closed = false;
    constructor(
        private readonly entries: () => readonly unknown[],
        private readonly prepare: (fact: SessionUsageFact) => () => Promise<void>,
        baseline: readonly unknown[] = entries(),
    ) {
        this.seen = new Set(baseline.map(entry => text(object(entry)?.id)).filter((id): id is string => id !== null));
    }
    reconcile(): Promise<void> {
        if (this.closed) return this.pending;
        // Snapshot before awaiting; a subsequent fork must not change the entries queued for this session.
        for (const fact of collectSessionUsage(this.entries())) {
            if (!this.seen.has(fact.sessionEntryId) && !this.writes.has(fact.sessionEntryId)) {
                // Retain the original attribution even if an append fails and tags later change.
                this.writes.set(fact.sessionEntryId, this.prepare(fact));
            }
        }
        const writes = [...this.writes];
        const task = this.pending.then(async () => {
            for (const [id, save] of writes) {
                if (this.seen.has(id)) continue;
                await save();
                this.seen.add(id);
                this.writes.delete(id);
            }
        });
        this.pending = task.catch(() => {});
        return task;
    }
    close(): Promise<void> { this.closed = true; return this.pending.then(() => { this.writes.clear(); }); }
}
