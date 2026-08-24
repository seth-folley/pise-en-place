import { describe, expect, it } from "vitest";
import { createSupacodeNotificationSequence } from "../src/shared/supacode-notifications.ts";

function metadataFields(sequence: string): Record<string, string> {
    const prefix = "\x1b]3008;start=pi;";
    const suffix = "\x1b\\";
    expect(sequence.startsWith(prefix)).toBe(true);
    expect(sequence.endsWith(suffix)).toBe(true);

    return Object.fromEntries(
        sequence
            .slice(prefix.length, -suffix.length)
            .split(";")
            .map((field) => {
                const separator = field.indexOf("=");
                return [field.slice(0, separator), field.slice(separator + 1)];
            }),
    );
}

function decodeField(value: string): string {
    const escaped = Buffer.from(value, "base64").toString("utf8");
    return JSON.parse(`"${escaped}"`) as string;
}

describe("Supacode attention notifications", () => {
    it("creates the rich OSC 3008 notification expected by Supacode", () => {
        const fields = metadataFields(createSupacodeNotificationSequence({ body: "Choose an option" }));

        expect(fields.kind).toBe("notify");
        expect(decodeField(fields.title)).toBe("Pi needs attention");
        expect(decodeField(fields.body)).toBe("Choose an option");
    });

    it("JSON-escapes notification text before base64 encoding it", () => {
        const body = "line \"one\"\nDONE ✓";
        const fields = metadataFields(createSupacodeNotificationSequence({ body }));

        expect(decodeField(fields.body)).toBe(body);
    });

    it("keeps encoded source fields within Supacode's wire budgets", () => {
        const sequence = createSupacodeNotificationSequence({
            title: "t".repeat(500),
            body: "b".repeat(2000),
        });
        const fields = metadataFields(sequence);

        expect(Buffer.from(fields.title, "base64")).toHaveLength(160);
        expect(Buffer.from(fields.body, "base64")).toHaveLength(1000);
        expect(Buffer.byteLength(sequence, "utf8")).toBeLessThan(2048);
    });
});
