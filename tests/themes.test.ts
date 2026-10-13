import { readFile } from "node:fs/promises";
import { Compile } from "typebox/compile";
import { expect, it } from "vitest";

it("Dracula references and conforms to Pi's published theme schema without requiring new optional colors", async () => {
    const theme = JSON.parse(await readFile(new URL("../themes/dracula-pro.json", import.meta.url), "utf8"));
    const schema = JSON.parse(await readFile(new URL("../node_modules/@earendil-works/pi-coding-agent/schemas/theme.schema.json", import.meta.url), "utf8"));
    expect(theme.$schema).toBe("https://pi.dev/schemas/theme.schema.json"); expect(theme.$schema).toBe(schema.$id);
    const validator = Compile(schema);
    expect(validator.Errors(theme)).toEqual([]); expect(validator.Check(theme)).toBe(true);
    expect(theme.colors.thinkingMax).toBeUndefined(); expect(theme.colors.scrollbarThumb).toBeUndefined();
    expect(theme.vars.background).toBe("#22212C"); expect(theme.export.pageBg).toBe("#22212C");
});
