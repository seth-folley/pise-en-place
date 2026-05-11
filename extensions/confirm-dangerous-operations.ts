import { homedir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type Hazard = {
    label: string;
    pattern: RegExp;
};

const protectedSystemRoots = [
    "/Applications",
    "/bin",
    "/boot",
    "/dev",
    "/etc",
    "/Library",
    "/opt",
    "/private/etc",
    "/private/var",
    "/sbin",
    "/System",
    "/usr",
    "/var",
    "/Volumes",
];

const piHome = path.resolve(homedir(), ".pi");

const hazards: Hazard[] = [
    { label: "privileged execution (sudo)", pattern: /(^|[;&|()\s])sudo(\s|$)/i },
    { label: "switch user/session", pattern: /(^|[;&|()\s])su(\s|$)/i },
    { label: "file deletion", pattern: /(^|[;&|()\s])(rm|rmdir|unlink|shred)(\s|$)/i },
    { label: "file truncation", pattern: /(^|[;&|()\s])truncate(\s|$)/i },
    { label: "find delete", pattern: /(^|[;&|()\s])find\b[\s\S]*\s-delete(\s|$)/i },
    { label: "xargs deletion", pattern: /(^|[;&|()\s])xargs\b[\s\S]*(^|[;&|()\s])rm(\s|$)/i },
    { label: "disk write", pattern: /(^|[;&|()\s])dd\b[\s\S]*\bof=/i },
    { label: "disk formatting", pattern: /(^|[;&|()\s])(mkfs|newfs|fdisk|parted|gparted)(\.|\s|$)/i },
    { label: "macOS disk erase/partition", pattern: /(^|[;&|()\s])diskutil\b[\s\S]*\b(erase|partition|apfs delete)/i },
    { label: "permission/ownership change", pattern: /(^|[;&|()\s])(chmod|chown|chgrp)(\s|$)/i },
    { label: "process termination", pattern: /(^|[;&|()\s])(kill|killall|pkill)(\s|$)/i },
    { label: "git destructive operation", pattern: /(^|[;&|()\s])git\s+(clean\b|reset\s+--hard\b|checkout\s+-f\b)/i },
    { label: "git working tree restore", pattern: /(^|[;&|()\s])git\s+restore\b/i },
    { label: "GitHub write operation", pattern: /(^|[;&|()\s])git\s+push\b/i },
    { label: "GitHub PR write operation", pattern: /(^|[;&|()\s])gh\s+pr\s+(create|edit|merge|close|reopen|ready|comment|review)\b/i },
    { label: "GitHub issue write operation", pattern: /(^|[;&|()\s])gh\s+issue\s+(create|edit|close|reopen|comment|transfer|delete|lock|unlock|pin|unpin|develop)\b/i },
    { label: "GitHub repo write operation", pattern: /(^|[;&|()\s])gh\s+repo\s+(create|delete|edit|archive|rename|fork)\b/i },
    { label: "GitHub release write operation", pattern: /(^|[;&|()\s])gh\s+release\s+(create|edit|delete|upload)\b/i },
    { label: "GitHub gist write operation", pattern: /(^|[;&|()\s])gh\s+gist\s+(create|edit|delete)\b/i },
    { label: "GitHub Actions write operation", pattern: /(^|[;&|()\s])gh\s+(workflow\s+run|run\s+(rerun|cancel|delete))\b/i },
    { label: "GitHub API write operation", pattern: /(^|[;&|()\s])gh\s+api\b[\s\S]*\s(-X|--method)\s*(POST|PUT|PATCH|DELETE)\b/i },
    { label: "GitHub API write operation", pattern: /(^|[;&|()\s])curl\b[\s\S]*(api\.github\.com|github\.com\/api)[\s\S]*\s(-X|--request)\s*(POST|PUT|PATCH|DELETE)\b/i },
    { label: "GitHub API write operation", pattern: /(^|[;&|()\s])curl\b[\s\S]*(api\.github\.com|github\.com\/api)[\s\S]*\s(-d|--data|--json)\b/i },
    { label: "shell script from network", pattern: /\b(curl|wget)\b[^|;&]*\|\s*(sh|bash|zsh|python|ruby|perl|node)\b/i },
    { label: "Docker destructive operation", pattern: /(^|[;&|()\s])docker\s+(system|container|image|volume|network)\s+prune\b/i },
    { label: "Docker destructive operation", pattern: /(^|[;&|()\s])docker\s+(rm|rmi)\b/i },
    { label: "Docker volume removal", pattern: /(^|[;&|()\s])docker\s+compose\s+down\b[\s\S]*\s-v(\s|$)/i },
    { label: "Kubernetes delete", pattern: /(^|[;&|()\s])kubectl\s+delete\b/i },
    { label: "Terraform apply/destroy", pattern: /(^|[;&|()\s])terraform\s+(apply|destroy)\b/i },
    { label: "package removal", pattern: /(^|[;&|()\s])(brew|apt|apt-get|yum|dnf|pacman)\s+[^;&|]*\b(uninstall|remove|purge|autoremove|cleanup)\b/i },
    { label: "package removal", pattern: /(^|[;&|()\s])(npm|yarn|pnpm|bun|pip|pipx|gem)\s+[^;&|]*\b(uninstall|remove)\b/i },
    { label: "writing sensitive path", pattern: /(>|>>|tee\s+)\s*(\/etc\/|~\/\.ssh\/|~\/\.aws\/|~\/\.gnupg\/)/i },
];

function addMatch(matches: string[], label: string) {
    if (!matches.includes(label)) {
        matches.push(label);
    }
}

function stripShellQuotes(value: string): string {
    return value.replace(/^["']|["']$/g, "");
}

function normalizeCandidatePath(candidate: string): string | undefined {
    const trimmed = stripShellQuotes(candidate.trim()).replace(/\\ /g, " ");
    if (trimmed.startsWith("~/")) {
        return path.resolve(homedir(), trimmed.slice(2));
    }
    if (!path.isAbsolute(trimmed)) return undefined;
    return path.resolve(trimmed);
}

function isPathInRoot(candidate: string, root: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isProtectedSystemPath(candidate: string): boolean {
    const normalized = normalizeCandidatePath(candidate);
    if (!normalized) return false;
    if (isPathInRoot(normalized, piHome)) return false;

    return protectedSystemRoots.some((root) => isPathInRoot(normalized, root));
}

function commandHasProtectedSystemWrite(command: string): boolean {
    const writePatterns = [
        /(?:^|\s)(?:\d*>|\d*>>|&>|>\|)\s*("[^"]+"|'[^']+'|\/\S+|~\/\S+)/g,
        /(?:^|[;&|()\s])tee\s+(?:-[a-zA-Z]+\s+)*("[^"]+"|'[^']+'|\/\S+|~\/\S+)/g,
        /(?:^|[;&|()\s])(?:cp|mv|install|touch|mkdir)\b[^;&|]*\s("[^"]+"|'[^']+'|\/\S+|~\/\S+)/g,
        /(?:^|[;&|()\s])(?:sed|perl)\b[^;&|]*\s-i(?:\s|\b)[^;&|]*\s("[^"]+"|'[^']+'|\/\S+|~\/\S+)/g,
    ];

    return writePatterns.some((pattern) => {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(command)) !== null) {
            const destination = match[1];
            if (destination && isProtectedSystemPath(destination)) return true;
        }
        return false;
    });
}

function detectHazards(command: string): string[] {
    const matches: string[] = [];

    for (const hazard of hazards) {
        if (hazard.pattern.test(command)) {
            addMatch(matches, hazard.label);
        }
    }

    if (commandHasProtectedSystemWrite(command)) {
        addMatch(matches, "writing system files outside ~/.pi");
    }

    return matches;
}

function summarizeCommand(command: string): string {
    const singleLine = command.replace(/\s+/g, " ").trim();
    if (singleLine.length <= 700) return singleLine;
    return `${singleLine.slice(0, 700)}…`;
}

async function confirmDangerousOperation(
    title: string,
    details: string,
    reasons: string[],
    ctx: ExtensionContext,
): Promise<boolean> {
    const reasonText = reasons.map((reason) => `• ${reason}`).join("\n");
    const message = `${reasonText}\n\n${details}`;

    if (!ctx.hasUI) {
        return false;
    }

    return ctx.ui.confirm(title, message);
}

async function confirmDangerousCommand(
    command: string,
    reasons: string[],
    ctx: ExtensionContext,
): Promise<boolean> {
    return confirmDangerousOperation(
        "Allow potentially dangerous bash command?",
        `Command:\n${summarizeCommand(command)}`,
        reasons,
        ctx,
    );
}

function blockedOutput(reasons: string[]): string {
    return `Blocked potentially dangerous operation: ${reasons.join(", ")}`;
}

function extractToolPath(input: unknown): string | undefined {
    if (!input || typeof input !== "object" || !("path" in input)) return undefined;

    const value = (input as { path?: unknown }).path;
    if (typeof value !== "string") return undefined;
    return value;
}

export default function (pi: ExtensionAPI) {
    pi.on("tool_call", async (event, ctx) => {
        if (event.toolName === "bash") {
            const command = String((event.input as { command?: unknown }).command ?? "");
            const reasons = detectHazards(command);
            if (reasons.length === 0) return undefined;

            const allowed = await confirmDangerousCommand(command, reasons, ctx);
            if (allowed) return undefined;

            return { block: true, reason: blockedOutput(reasons) };
        }

        if (event.toolName === "write" || event.toolName === "edit") {
            const toolPath = extractToolPath(event.input);
            if (!toolPath || !isProtectedSystemPath(toolPath)) return undefined;

            const reasons = ["writing system files outside ~/.pi"];
            const allowed = await confirmDangerousOperation(
                "Allow writing to a system file?",
                `Tool: ${event.toolName}\nPath: ${toolPath}`,
                reasons,
                ctx,
            );
            if (allowed) return undefined;

            return { block: true, reason: blockedOutput(reasons) };
        }

        return undefined;
    });

    pi.on("user_bash", async (event, ctx) => {
        const reasons = detectHazards(event.command);
        if (reasons.length === 0) return undefined;

        const allowed = await confirmDangerousCommand(event.command, reasons, ctx);
        if (allowed) return undefined;

        return {
            result: {
                output: blockedOutput(reasons),
                exitCode: 126,
                cancelled: false,
                truncated: false,
            },
        };
    });
}
