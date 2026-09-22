import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { disabledSkillForBashCommand, disabledSkillForPath, type DisabledSkillDirectory } from "../../../src/shared/disabled-skill-access.ts";

export const disabledSkillDirectoriesEnvironmentVariable = "PISE_DISABLED_SKILL_DIRECTORIES";

function directoriesFromEnvironment(): DisabledSkillDirectory[] {
	try {
		const parsed = JSON.parse(process.env[disabledSkillDirectoriesEnvironmentVariable] ?? "[]");
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry): entry is DisabledSkillDirectory =>
			!!entry && typeof entry === "object" && typeof entry.name === "string" && typeof entry.path === "string",
		);
	} catch {
		return [];
	}
}

/** Applies the parent session's disabled-skill filesystem guard to isolated subagents. */
export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event, ctx) => {
		const directories = directoriesFromEnvironment();
		if (!directories.length) return;
		if (isToolCallEventType("bash", event)) {
			const skill = disabledSkillForBashCommand(event.input.command, ctx.cwd, directories);
			if (skill) return { block: true, reason: `Blocked access to disabled project skill: ${skill.name}` };
			return;
		}
		if (!isToolCallEventType("read", event) && !isToolCallEventType("grep", event) && !isToolCallEventType("find", event) && !isToolCallEventType("ls", event)) return;
		const input = event.input as { path?: unknown };
		if (typeof input.path !== "string") return;
		const skill = disabledSkillForPath(input.path, ctx.cwd, directories);
		if (skill) return { block: true, reason: `Blocked access to disabled project skill: ${skill.name}` };
	});
}
