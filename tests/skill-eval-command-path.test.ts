import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCommandPath } from "../extensions/evals/skill-eval/paths.ts";

describe("skill eval command paths", () => {
	const cwd = path.join(path.parse(process.cwd()).root, "current", "project");

	it("resolves relative paths from Pi's current working directory", () => {
		expect(resolveCommandPath("evals/example.yaml", cwd)).toBe(path.join(cwd, "evals", "example.yaml"));
	});

	it("preserves absolute paths instead of appending them to the current directory", () => {
		const absolute = path.join(path.parse(cwd).root, "tmp", "example.yaml");
		expect(resolveCommandPath(absolute, cwd)).toBe(absolute);
	});

	it("accepts quoted absolute paths containing spaces", () => {
		const absolute = path.join(path.parse(cwd).root, "tmp", "Eval Files", "example.yaml");
		expect(resolveCommandPath(`"${absolute}"`, cwd)).toBe(absolute);
		expect(resolveCommandPath(`'${absolute}'`, cwd)).toBe(absolute);
	});

	it("expands home-relative paths", () => {
		expect(resolveCommandPath("~/evals/example.yaml", cwd)).toBe(path.join(os.homedir(), "evals", "example.yaml"));
	});
});
