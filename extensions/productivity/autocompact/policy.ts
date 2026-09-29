export { effectiveCeiling } from "../../../src/shared/autocompact-status.ts";

export class CompactionCycle {
    private warned = 0;
    private attempted = false;

    reset(): void {
        this.warned = 0;
        this.attempted = false;
    }

    markAttempt(): void {
        this.attempted = true;
    }

    // Successful compaction resets warnings, but do not compact repeatedly if
    // the retained context still exceeds the ceiling. Rearm on a below-limit sample.
    compacted(): void {
        this.warned = 0;
        this.attempted = true;
    }

    observe(tokens: number | null | undefined, ceiling: number): 80 | 90 | "compact" | "blocked" | undefined {
        if (tokens == null || !Number.isFinite(tokens) || tokens < 0) return;
        if (tokens < ceiling) this.attempted = false;
        if (tokens >= ceiling) {
            return this.attempted ? "blocked" : "compact";
        }
        const level = tokens >= ceiling * 0.9 ? 90 : tokens >= ceiling * 0.8 ? 80 : 0;
        if (level > this.warned) {
            this.warned = level;
            return level as 80 | 90;
        }
    }
}
