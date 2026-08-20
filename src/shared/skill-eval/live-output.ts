import { createServer, type Server, type Socket } from "node:net";
import { chmod, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface LiveOutputEvent { type: "output"; cellId: string; stream: "stdout" | "stderr"; text: string; timestamp: string }
export function liveOutputSocketPath(runId: string): string { return path.join(os.tmpdir(), `pi-eval-${runId.slice(-24)}.sock`); }

/** Ephemeral, local-only raw output transport. It never writes output to disk. */
export class LiveOutputServer {
	private readonly clients = new Set<Socket>();
	private server?: Server;
	constructor(readonly socketPath: string) {}
	async start(): Promise<void> {
		if (process.platform === "win32") return;
		await unlink(this.socketPath).catch(() => undefined);
		this.server = createServer((socket) => { this.clients.add(socket); socket.on("close", () => this.clients.delete(socket)); socket.on("error", () => this.clients.delete(socket)); });
		await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.socketPath, () => { this.server!.off("error", reject); resolve(); }); }); await chmod(this.socketPath, 0o600);
	}
	publish(event: Omit<LiveOutputEvent, "type" | "timestamp">): void {
		const line = `${JSON.stringify({ type: "output", timestamp: new Date().toISOString(), ...event } satisfies LiveOutputEvent)}\n`;
		for (const client of this.clients) if (!client.destroyed) client.write(line);
	}
	async close(): Promise<void> { for (const client of this.clients) client.destroy(); await new Promise<void>((resolve) => this.server ? this.server.close(() => resolve()) : resolve()); await unlink(this.socketPath).catch(() => undefined); }
}
