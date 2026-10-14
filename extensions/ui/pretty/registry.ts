import type { ToolRenderers } from "@earendil-works/pi-coding-agent";

type RenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
export interface Formatter { id: string; group: string; description: string; toolName: string; }
const ROW = Symbol("pretty-row");
type Row = { invalidate: () => void; generation: number };

/** Session-only choices and weak redraw handles; no strong references to old transcript rows. */
export class PrettyRegistry {
	private disabled = new Set<string>();
	private rows = new Set<WeakRef<Row>>();
	private generation = 0;
	constructor(readonly formatters: readonly Formatter[]) {}
	enabled(id: string): boolean { return !this.disabled.has(id); }
	reset(): void { this.disabled.clear(); this.rows.clear(); this.generation++; }
	track(context: RenderContext): void {
		let row = context.state[ROW] as Row | undefined;
		if (!row) {
			row = { invalidate: context.invalidate, generation: -1 };
			context.state[ROW] = row;
		}
		if (row.generation !== this.generation) {
			this.rows.add(new WeakRef(row)); row.generation = this.generation;
		}
		row.invalidate = context.invalidate;
	}
	set(target: string | undefined, enabled: boolean): boolean {
		const selected = this.formatters.filter(f => !target || f.id === target || f.group === target);
		if (!selected.length) return false;
		for (const formatter of selected) {
			if (enabled) this.disabled.delete(formatter.id); else this.disabled.add(formatter.id);
		}
		for (const ref of this.rows) {
			const row = ref.deref();
			if (!row) { this.rows.delete(ref); continue; }
			try { row.invalidate(); } catch { this.rows.delete(ref); row.generation = -1; }
		}
		return true;
	}
	status(): string {
		return "Pretty formatters (session only; reset on reload/new session):\n" + this.formatters
			.map(f => `  ${f.id}: ${this.enabled(f.id) ? "on" : "off"} — ${f.description}`).join("\n");
	}
}
