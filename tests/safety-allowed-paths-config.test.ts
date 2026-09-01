import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isReadOnlyWorkspaceCommand, loadSafetyReadOnlyPaths } from "../extensions/safety/index.ts";

describe("safety allowed read-only paths config", () => {
    it("is opt-in and expands portable $HOME paths", () => {
        const directory = mkdtempSync(path.join(tmpdir(), "pise-safety-config-"));
        const configPath = path.join(directory, "safety.json");
        const home = path.join(directory, "home");

        try {
            expect(loadSafetyReadOnlyPaths(configPath, home)).toEqual([]);

            writeFileSync(configPath, JSON.stringify({
                version: 1,
                readOnlyPaths: ["$HOME/.pi", "$HOME/../outside", "/etc"],
            }));
            expect(loadSafetyReadOnlyPaths(configPath, home)).toEqual([path.join(home, ".pi")]);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("permits configured home paths with the existing read-only grammar only", () => {
        const workspace = "/tmp/pise-safety-workspace";
        const home = homedir();
        const roots = [home];

        expect(isReadOnlyWorkspaceCommand("rg -n --hidden 'safety-dialog' $HOME/.pi/agent/sessions 2>/dev/null | head -1", workspace, roots)).toBe(true);
        expect(isReadOnlyWorkspaceCommand("rg secret $HOME/.ssh", workspace)).toBe(false);
        expect(isReadOnlyWorkspaceCommand("rg secret $HOME/.ssh", workspace, roots)).toBe(true);
        expect(isReadOnlyWorkspaceCommand("rm -f $HOME/probe", workspace, roots)).toBe(false);
        expect(isReadOnlyWorkspaceCommand("rg secret /etc", workspace, roots)).toBe(false);
        expect(isReadOnlyWorkspaceCommand("rg secret $OTHER_HOME", workspace, roots)).toBe(false);
    });

    it("fails closed for invalid config", () => {
        const directory = mkdtempSync(path.join(tmpdir(), "pise-safety-config-"));
        const configPath = path.join(directory, "safety.json");

        try {
            writeFileSync(configPath, JSON.stringify({ version: 2, readOnlyPaths: ["$HOME"] }));
            expect(loadSafetyReadOnlyPaths(configPath)).toEqual([]);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
