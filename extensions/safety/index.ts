import { homedir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notifySupacodeAttention } from "../../src/shared/supacode-notifications.ts";

type Hazard = {
    label: string;
    pattern: RegExp;
};

type DangerousOperationAction = "allow" | "block" | "explain";

type ExplanationRequest = {
    command: string;
    normalizedCommand: string;
    reasons: string[];
    requestedAt: number;
    count: number;
    explanation?: string;
    explainedAt?: number;
};

type ContentBlock = {
    type?: string;
    text?: string;
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

const allowedTempScratchRoots = [
    "/tmp",
    "/private/tmp",
];

const tempScopedFileHazards = [
    "file deletion",
    "file truncation",
    "find delete",
    "permission/ownership change",
];

const fileOperationCommands = new Set(["rm", "rmdir", "unlink", "shred", "truncate", "chmod", "chown", "chgrp"]);

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

function isAllowedTempScratchPath(candidate: string): boolean {
    const normalized = normalizeCandidatePath(candidate);
    if (!normalized) return false;

    return allowedTempScratchRoots.some((root) => isPathInRoot(normalized, root));
}

function tokenizeShellLike(command: string): string[] {
    return command.match(/&&|\|\||[;&|()]|"(?:\\.|[^"])*"|'[^']*'|[^\s;&|()]+/g) ?? [];
}

function isShellSeparator(token: string): boolean {
    return token === ";" || token === "&&" || token === "||" || token === "|" || token === "(" || token === ")";
}

function cleanToken(token: string): string {
    return stripShellQuotes(token.trim());
}

function commandName(token: string): string {
    return path.basename(cleanToken(token));
}

function isPathLikeToken(token: string): boolean {
    const cleaned = cleanToken(token);
    return cleaned.startsWith("/") || cleaned.startsWith("~/");
}

function allPathMentionsAreAllowedTemp(tokens: string[]): boolean {
    return tokens.every((token) => !isPathLikeToken(token) || isAllowedTempScratchPath(cleanToken(token)));
}

function isOptionToken(token: string): boolean {
    return cleanToken(token).startsWith("-");
}

function fileOperandsForCommand(command: string, args: string[]): string[] | undefined {
    const operands: string[] = [];
    let skippedSubject = false;

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (isShellSeparator(arg)) break;

        const cleaned = cleanToken(arg);
        if (!cleaned) continue;

        if (isOptionToken(cleaned)) {
            if (command === "truncate" && (cleaned === "-s" || cleaned === "--size")) {
                index += 1;
            }
            continue;
        }

        if ((command === "chmod" || command === "chown" || command === "chgrp") && !skippedSubject) {
            skippedSubject = true;
            continue;
        }

        operands.push(cleaned);
    }

    return operands;
}

function segmentIsTempScopedFindDelete(segment: string[]): boolean {
    const findIndex = segment.findIndex((token) => commandName(token) === "find");
    if (findIndex < 0 || !segment.includes("-delete")) return false;

    const firstSearchPath = segment.slice(findIndex + 1).find((token) => !isOptionToken(token));
    return firstSearchPath !== undefined && isAllowedTempScratchPath(firstSearchPath);
}

function segmentIsTempScopedFileOperation(segment: string[]): boolean {
    if (segmentIsTempScopedFindDelete(segment)) return true;
    if (segment.some((token) => commandName(token) === "xargs")) return false;

    const commandIndex = segment.findIndex((token) => fileOperationCommands.has(commandName(token)));
    if (commandIndex < 0) return false;

    const command = commandName(segment[commandIndex]);
    const operands = fileOperandsForCommand(command, segment.slice(commandIndex + 1));
    return operands !== undefined && operands.length > 0 && operands.every((operand) => isAllowedTempScratchPath(operand));
}

function segmentHasTempScopedCandidate(segment: string[]): boolean {
    return segment.some((part) => fileOperationCommands.has(commandName(part)) || commandName(part) === "find");
}

function isTempScopedFileOperation(command: string, matches: string[]): boolean {
    if (!matches.every((match) => tempScopedFileHazards.includes(match))) return false;
    if (/[`]|\$\(/.test(command)) return false;

    const tokens = tokenizeShellLike(command);
    if (tokens.length === 0 || !allPathMentionsAreAllowedTemp(tokens)) return false;

    let sawTempScopedOperation = false;
    let segment: string[] = [];

    for (const token of tokens) {
        if (!isShellSeparator(token)) {
            segment.push(token);
            continue;
        }

        if (segment.length > 0 && segmentHasTempScopedCandidate(segment)) {
            const safe = segmentIsTempScopedFileOperation(segment);
            if (!safe) return false;
            sawTempScopedOperation = true;
        }
        segment = [];
    }

    if (segment.length > 0 && segmentHasTempScopedCandidate(segment)) {
        const safe = segmentIsTempScopedFileOperation(segment);
        if (!safe) return false;
        sawTempScopedOperation = true;
    }

    return sawTempScopedOperation;
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

    if (matches.length > 0 && isTempScopedFileOperation(command, matches)) {
        return [];
    }

    return matches;
}

function summarizeCommand(command: string): string {
    const singleLine = command.replace(/\s+/g, " ").trim();
    if (singleLine.length <= 700) return singleLine;
    return `${singleLine.slice(0, 700)}…`;
}

function normalizeCommandKey(command: string): string {
    return command.replace(/\r\n?/g, "\n").trim();
}

function pruneExplanationRequests(
    explanationRequests: Map<string, ExplanationRequest>,
    maxAgeMs = 60 * 60 * 1000,
): void {
    const now = Date.now();
    for (const [key, request] of explanationRequests) {
        if (now - request.requestedAt > maxAgeMs) {
            explanationRequests.delete(key);
        }
    }
}

function getExplanationRequest(
    explanationRequests: Map<string, ExplanationRequest>,
    command: string,
): ExplanationRequest | undefined {
    pruneExplanationRequests(explanationRequests);
    return explanationRequests.get(normalizeCommandKey(command));
}

function recordExplanationRequest(
    explanationRequests: Map<string, ExplanationRequest>,
    command: string,
    reasons: string[],
): string {
    pruneExplanationRequests(explanationRequests);

    const normalizedCommand = normalizeCommandKey(command);
    const existing = explanationRequests.get(normalizedCommand);
    explanationRequests.set(normalizedCommand, {
        command,
        normalizedCommand,
        reasons,
        requestedAt: Date.now(),
        count: (existing?.count ?? 0) + 1,
        explanation: existing?.explanation,
        explainedAt: existing?.explainedAt,
    });

    return normalizedCommand;
}

function extractTextParts(content: unknown): string[] {
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];

    const textParts: string[] = [];
    for (const part of content) {
        if (!part || typeof part !== "object") continue;

        const block = part as ContentBlock;
        if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
        }
    }

    return textParts;
}

function extractDangerousCommandExplanation(text: string): string | undefined {
    const match = text.match(/```dangerous-command-explanation\s*\n([\s\S]*?)```/i);
    if (!match) return undefined;

    return `\`\`\`dangerous-command-explanation\n${match[1].trim()}\n\`\`\``;
}

function formatExplanationForDisplay(explanation: string): string {
    const unfenced = explanation
        .replace(/^```dangerous-command-explanation\s*\n/i, "")
        .replace(/\n```$/i, "")
        .trim();

    if (unfenced.length <= 1200) return unfenced;
    return `${unfenced.slice(0, 1200)}…`;
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

    notifySupacodeAttention(`Permission required: ${title} ${reasons.join(", ")}`);
    return ctx.ui.confirm(title, message);
}

async function chooseDangerousCommandAction(
    command: string,
    reasons: string[],
    priorExplanationRequest: ExplanationRequest | undefined,
    ctx: ExtensionContext,
): Promise<DangerousOperationAction> {
    if (!ctx.hasUI) {
        return "block";
    }

    const reasonText = reasons.map((reason) => `• ${reason}`).join("\n");
    const priorExplanationText = priorExplanationRequest?.explanation
        ? `\n\nPrevious explanation:\n${formatExplanationForDisplay(priorExplanationRequest.explanation)}`
        : priorExplanationRequest
            ? `\n\nNote: an explanation was requested for this command during this session, but no formatted explanation has been captured yet.`
            : "";
    const message = `Allow potentially dangerous bash command?\n\n${reasonText}\n\nCommand:\n${summarizeCommand(command)}${priorExplanationText}`;

    const allowLabel = "Allow once";
    const blockLabel = "Block";
    const explainLabel = "Explain";

    notifySupacodeAttention(
        `Permission required: Allow potentially dangerous bash command? ${reasons.join(", ")}`,
    );
    const choice = await ctx.ui.select(message, [allowLabel, blockLabel, explainLabel]);
    if (choice === allowLabel) return "allow";
    if (choice === explainLabel) return "explain";
    return "block";
}

function blockedOutput(reasons: string[]): string {
    return `Blocked potentially dangerous operation: ${reasons.join(", ")}`;
}

function explanationRequestOutput(command: string, reasons: string[]): string {
    return `Blocked potentially dangerous operation pending explanation: ${reasons.join(", ")}\n\nBefore retrying this command, respond using exactly this format:\n\n\`\`\`dangerous-command-explanation\ntools: <comma-separated command-line programs invoked by the bash command, such as rm, git, gh, curl, or docker; do not list the Pi bash tool itself: ${summarizeCommand(command)}>\ndescription: <plainly describe the effect of this tool call, without mentioning the tool or command name and without explaining why it is used>\nreason: <the actual reason for using this tool call>\nrisk: <low|medium|high|extreme>\n\`\`\`\n\nUse exactly these four keys. Keep each value on a single line. Do not retry the command until the user explicitly approves.`;
}

function extractToolPath(input: unknown): string | undefined {
    if (!input || typeof input !== "object" || !("path" in input)) return undefined;

    const value = (input as { path?: unknown }).path;
    if (typeof value !== "string") return undefined;
    return value;
}

export default function (pi: ExtensionAPI) {
    const explanationRequests = new Map<string, ExplanationRequest>();
    const pendingExplanationCommandKeys = new Set<string>();

    pi.on("message_end", async (event) => {
        if (pendingExplanationCommandKeys.size === 0) return;
        if (event.message.role !== "assistant") return;

        const text = extractTextParts(event.message.content).join("\n").trim();
        if (!text) return;

        const explanation = extractDangerousCommandExplanation(text);
        if (!explanation) return;

        const now = Date.now();
        for (const key of pendingExplanationCommandKeys) {
            const request = explanationRequests.get(key);
            if (!request) continue;

            request.explanation = explanation;
            request.explainedAt = now;
        }
        pendingExplanationCommandKeys.clear();
    });

    pi.on("tool_call", async (event, ctx) => {
        if (event.toolName === "bash") {
            const command = String((event.input as { command?: unknown }).command ?? "");
            const reasons = detectHazards(command);
            if (reasons.length === 0) return undefined;

            const priorExplanationRequest = getExplanationRequest(explanationRequests, command);
            const action = await chooseDangerousCommandAction(command, reasons, priorExplanationRequest, ctx);
            if (action === "allow") return undefined;

            if (action === "explain") {
                const commandKey = recordExplanationRequest(explanationRequests, command, reasons);
                pendingExplanationCommandKeys.add(commandKey);
                return { block: true, reason: explanationRequestOutput(command, reasons) };
            }

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

        const priorExplanationRequest = getExplanationRequest(explanationRequests, event.command);
        const action = await chooseDangerousCommandAction(event.command, reasons, priorExplanationRequest, ctx);
        if (action === "allow") return undefined;

        const output = action === "explain"
            ? explanationRequestOutput(event.command, reasons)
            : blockedOutput(reasons);

        if (action === "explain") {
            const commandKey = recordExplanationRequest(explanationRequests, event.command, reasons);
            pendingExplanationCommandKeys.add(commandKey);
        }

        return {
            result: {
                output,
                exitCode: 126,
                cancelled: false,
                truncated: false,
            },
        };
    });
}
