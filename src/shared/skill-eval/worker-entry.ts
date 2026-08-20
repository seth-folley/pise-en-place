import { runController } from "./controller.ts";

const runId = process.argv[2];
if (!runId) {
	console.error("Usage: worker-entry.ts <run-id>");
	process.exitCode = 2;
} else {
	runController(runId).catch((error) => {
		console.error(error instanceof Error ? error.stack ?? error.message : String(error));
		process.exitCode = 1;
	});
}
