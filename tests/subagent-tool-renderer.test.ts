import { describe, expect, it } from "vitest";
import { renderSubagentResult, subagentStatus, tasksFromArgs, type SubagentToolResult } from "../extensions/orchestration/subagent/tool-renderer.ts";

const tasks: SubagentToolResult[] = [
    { agent: "scout", task: "Inspect files", exitCode: -1 },
    { agent: "researcher", task: "Read docs", exitCode: -1 },
];

describe("subagent tool renderer", () => {
    it("uses single and parallel task arguments consistently", () => {
        expect(tasksFromArgs({ agent: "scout", task: "Inspect files" })).toEqual([{ agent: "scout", task: "Inspect files" }]);
        expect(tasksFromArgs({ tasks: tasks.map(({ agent, task }) => ({ agent, task })) })).toHaveLength(2);
    });

    it("summarizes running, successful, and failed work for the header", () => {
        expect(subagentStatus(tasks, "parallel")).toBe("2 parallel");
        expect(subagentStatus(tasks.map((task) => ({ ...task, exitCode: 0 })), "parallel")).toBe("2/2 complete");
        expect(subagentStatus([{ ...tasks[0], exitCode: 0 }, { ...tasks[1], exitCode: 1 }], "parallel")).toBe("1/2 complete · 1 failed");
    });

    it("shows each subagent response alongside its delegated task when expanded", () => {
        const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
        const component = renderSubagentResult(
            { content: [], details: { mode: "single", results: [{ agent: "scout", task: "Inspect files", output: "Found the extension entrypoint.", exitCode: 0 }] } },
            { expanded: true },
            theme,
            { state: {} },
        );
        expect(component.render(120).map((line) => line.trimEnd()).join("\n")).toContain("Result:\nFound the extension entrypoint.");
    });
});
