import type {
    ExtensionCommandContext,
    ExtensionDiffFile,
    ExtensionFileViewInput,
    HunkExtensionAPI,
} from "hunkdiff/extension";
import { describe, expect, it, vi } from "vitest";
import collapseFiles from "../extensions/hunk/collapse-files.ts";

function harness() {
    const registerFileView = vi.fn<HunkExtensionAPI["registerFileView"]>();
    const registerCommand = vi.fn<HunkExtensionAPI["registerCommand"]>();
    collapseFiles({ registerFileView, registerCommand } as unknown as HunkExtensionAPI);
    return {
        registerFileView, registerCommand,
        view: registerFileView.mock.calls[0][0],
        command: registerCommand.mock.calls[0][0],
        handler: registerCommand.mock.calls[0][1],
    };
}

function file(overrides: Partial<ExtensionDiffFile> = {}): ExtensionDiffFile {
    return {
        id: "file:0", path: "src/example.ts", patch: "", metadata: {}, agent: null,
        stats: { additions: 12, deletions: 3 },
        hunks: [
            { index: 0, header: "@@ -1,3 +1,5 @@", oldRange: [1, 3], newRange: [1, 5] },
            { index: 1, header: "@@ -10,2 +12,3 @@", oldRange: [10, 11], newRange: [12, 14] },
        ],
        ...overrides,
    };
}

function input(selected = file(), width = 80): ExtensionFileViewInput {
    return {
        file: selected, width, signal: new AbortController().signal, changes: [],
        readDocument: vi.fn(async () => null),
    };
}

function context(selected: ExtensionDiffFile | null) {
    const toggle = vi.fn();
    const notify = vi.fn();
    const ctx = {
        selection: { file: selected }, fileViews: { toggle }, notify,
    } as unknown as ExtensionCommandContext;
    return { ctx, toggle, notify };
}

describe("Hunk file collapse", () => {
    it("registers one file view and a Z command also exposed by Hunk's Extensions menu", () => {
        const h = harness();
        expect(h.registerFileView).toHaveBeenCalledTimes(1);
        expect(h.registerCommand).toHaveBeenCalledTimes(1);
        expect(h.view.id).toBe("collapsed");
        expect(h.command).toEqual({ id: "toggle", title: "Toggle file collapse", key: "Z" });
    });

    it("maps every hunk onto one summary row without source bindings or document reads", async () => {
        const h = harness();
        const request = input();
        const before = structuredClone(request.file);
        Object.freeze(request.file);
        const layout = await h.view.layout(request);
        expect(layout?.rows).toHaveLength(1);
        expect(layout?.hunkRows).toEqual([
            { startRow: 0, endRow: 0 }, { startRow: 0, endRow: 0 },
        ]);
        expect(layout?.rows[0].sourceRanges).toBeUndefined();
        expect(layout?.rows[0].spans.map(span => span.text).join("")).toBe("▸ Collapsed · 2 hunks · +12 −3");
        expect(request.readDocument).not.toHaveBeenCalled();
        expect(request.file).toEqual(before);
    });

    it("uses singular wording for a one-hunk file", async () => {
        const layout = await harness().view.layout(input(file({ hunks: file().hunks!.slice(0, 1) })));
        expect(layout?.rows[0].spans[1].text).toBe(" · 1 hunk");
    });

    it.each([
        { hunks: [], isBinary: true },
        { hunks: undefined, isTooLarge: true },
        { hunks: [], isUntracked: true },
    ])("handles a zero-hunk file: %j", async (overrides) => {
        const h = harness();
        const selected = file(overrides);
        expect(h.view.matches(selected)).toBe(true);
        const layout = await h.view.layout(input(selected));
        expect(layout?.rows).toHaveLength(1);
        expect(layout?.hunkRows).toEqual([]);
        expect(layout?.rows[0].spans[1].text).toBe(" · 0 hunks");
    });

    it("labels truncated stats and remains deterministic at narrow widths", async () => {
        const view = harness().view;
        const selected = file({ statsTruncated: true });
        const narrow = await view.layout(input(selected, 1));
        expect(narrow).toEqual(await view.layout(input(selected, 120)));
        expect(narrow?.rows[0].spans.at(-1)?.text).toBe(" −3 (partial)");
    });

    it("delegates repeated toggles to Hunk's selected-file presentation controls", async () => {
        const h = harness();
        const a = context(file());
        const b = context(file({ id: "file:1", path: "another.ts" }));
        await h.handler(a.ctx);
        await h.handler(b.ctx);
        await h.handler(a.ctx);
        expect(a.toggle).toHaveBeenCalledTimes(2);
        expect(a.toggle).toHaveBeenNthCalledWith(1, "collapsed");
        expect(a.toggle).toHaveBeenNthCalledWith(2, "collapsed");
        expect(b.toggle).toHaveBeenCalledExactlyOnceWith("collapsed");
        expect(a.notify).not.toHaveBeenCalled();
    });

    it("does not toggle when filtering leaves no selected file", async () => {
        const h = harness();
        const c = context(null);
        await h.handler(c.ctx);
        expect(c.toggle).not.toHaveBeenCalled();
        expect(c.notify).toHaveBeenCalledExactlyOnceWith("No file selected");
    });
});
