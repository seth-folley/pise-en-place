import type { HunkExtensionAPI } from "hunkdiff/extension";

/** Hunk-only extension: deliberately not registered in package.json's pi.extensions. */
export default function collapseFiles(hunk: HunkExtensionAPI) {
    hunk.registerFileView({
        id: "collapsed",
        title: "Collapsed file",
        matches: () => true,
        layout: ({ file }) => {
            const count = file.hunks?.length ?? 0;
            return {
                rows: [{
                    id: "collapsed-summary",
                    spans: [
                        { text: "▸ Collapsed", tone: "muted" },
                        { text: ` · ${count} ${count === 1 ? "hunk" : "hunks"}`, tone: "muted" },
                        { text: ` · +${file.stats.additions}`, tone: "added" },
                        { text: ` −${file.stats.deletions}${file.statsTruncated ? " (partial)" : ""}`, tone: "removed" },
                    ],
                }],
                // Every hunk lands on the same summary row. No source bindings:
                // visible inline notes must fall back to raw, never disappear.
                hunkRows: (file.hunks ?? []).map(() => ({ startRow: 0, endRow: 0 })),
            };
        },
    });

    hunk.registerCommand(
        { id: "toggle", title: "Toggle file collapse", key: "Z" },
        (ctx) => {
            if (!ctx.selection.file) {
                ctx.notify("No file selected");
                return;
            }
            // Hunk owns per-file presentation state and restores raw diff on expand.
            ctx.fileViews.toggle("collapsed");
        },
    );
}
