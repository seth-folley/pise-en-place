import { describe, expect, it } from "vitest";
import { commandHasProtectedSystemWrite, isReadOnlyWorkspaceCommand } from "../extensions/safety/index.ts";

const workspace = "/tmp/pise-safety-workspace";

describe("read-only workspace shell commands", () => {
    it("allows common workspace reconnaissance", () => {
        expect(isReadOnlyWorkspaceCommand("find .agents .pi -type f -iname '*finish*' 2>/dev/null | sort", workspace)).toBe(true);
        expect(isReadOnlyWorkspaceCommand("rg -n --hidden 'dox-finish-pr|finish-pr' .agents", workspace)).toBe(false);
        expect(isReadOnlyWorkspaceCommand("if [ -f .agents/skill-policy.local.md ]; then printf '%s\\n' PRESENT; else printf '%s\\n' ABSENT; fi; find .agents -maxdepth 2 -type f -name '*policy*' -print", workspace)).toBe(true);
        expect(isReadOnlyWorkspaceCommand("find .agents .pi -type f -iname '*finish*' 2>/dev/null", workspace)).toBe(true);
        expect(isReadOnlyWorkspaceCommand("rg -n --hidden 'dox-finish-pr' .agents", workspace)).toBe(true);
        expect(isReadOnlyWorkspaceCommand("git status --short --branch", workspace)).toBe(true);
        expect(isReadOnlyWorkspaceCommand("gh label list --search ciautorun --limit 10", workspace)).toBe(true);
    });

    it("does not treat null-device redirects as protected system writes", () => {
        expect(commandHasProtectedSystemWrite("git show abc:SKILL.md 2>/dev/null || git show def:SKILL.md")).toBe(false);
        expect(commandHasProtectedSystemWrite("git show abc:SKILL.md >/dev/null")).toBe(false);
        expect(commandHasProtectedSystemWrite("git show abc:SKILL.md > /etc/skill.md")).toBe(true);
        expect(commandHasProtectedSystemWrite("touch /dev/null")).toBe(true);
    });

    it("rejects ambiguous, external, or effectful commands", () => {
        expect(isReadOnlyWorkspaceCommand("find . -delete", workspace)).toBe(false);
        expect(isReadOnlyWorkspaceCommand("rg --pre formatter pattern .", workspace)).toBe(false);
        expect(isReadOnlyWorkspaceCommand("git status && rm -rf build", workspace)).toBe(false);
        expect(isReadOnlyWorkspaceCommand("git branch new-branch", workspace)).toBe(false);
        expect(isReadOnlyWorkspaceCommand("git branch -D stale-branch", workspace)).toBe(false);
        expect(isReadOnlyWorkspaceCommand("find . -fprint results.txt", workspace)).toBe(false);
        expect(isReadOnlyWorkspaceCommand("rg secret ~/.ssh", workspace)).toBe(false);
        expect(isReadOnlyWorkspaceCommand("if [ -f file ]; then rm file; fi", workspace)).toBe(false);
        expect(isReadOnlyWorkspaceCommand("rg pattern . > results.txt", workspace)).toBe(false);
    });
});
