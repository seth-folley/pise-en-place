import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaults, loadConfig, parseConfig, saveConfig } from "../extensions/productivity/autocompact/config.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "autocompact-"));
    dirs.push(dir);
    return path.join(dir, "autocompact.json");
}

describe("autocompact configuration", () => {
    it("is opt-in, with a 250k ceiling, without creating a file on read", async () => {
        const file = await fixture();
        expect(await loadConfig(file)).toEqual(defaults);
        await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("serializes read-modify-write updates and preserves the other field", async () => {
        const file = await fixture();
        await Promise.all([saveConfig({ enabled: true }, file), saveConfig({ ceilingTokens: 240_000 }, file)]);
        expect(await loadConfig(file)).toEqual({ enabled: true, ceilingTokens: 240_000 });
        await saveConfig({ enabled: false }, file);
        expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ enabled: false, ceilingTokens: 240_000 });
    });

    it("rejects invalid data rather than overwriting a corrupt file", async () => {
        const file = await fixture();
        await writeFile(file, "broken json");
        await expect(loadConfig(file)).rejects.toThrow();
        await expect(saveConfig({ enabled: true }, file)).rejects.toThrow();
        expect(await readFile(file, "utf8")).toBe("broken json");
        for (const value of [null, [], { enabled: "yes" }, { ceilingTokens: 0 }, { ceilingTokens: -1 },
            { ceilingTokens: 1.5 }, { ceilingTokens: Number.MAX_SAFE_INTEGER + 1 }]) {
            expect(() => parseConfig(value)).toThrow();
        }
    });
});
