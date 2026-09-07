import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fail } from "./protocol.ts";

export function teamPaths(root = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")) {
    const directory = join(resolve(root), "coordination");
    return { directory, socket: join(directory, "broker.sock"), database: join(directory, "broker.sqlite"), control: join(directory, "control.key") };
}
export type TeamPaths = ReturnType<typeof teamPaths>;
export async function privatePath(path: string, directory = false): Promise<void> {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
        (process.getuid && stat.uid !== process.getuid())) fail("PERMISSIONS", `Unsafe coordination path: ${path}`);
    await chmod(path, directory ? 0o700 : 0o600);
}
export async function preparePaths(paths: TeamPaths): Promise<string> {
    if (process.platform === "win32") fail("PLATFORM", "Coordination v1 requires macOS/Linux Unix sockets.");
    if (Buffer.byteLength(paths.socket) > 100) fail("PATH", "Unix socket path is too long. Use a shorter PI_CODING_AGENT_DIR (and the same value for Pi and broker).");
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    await privatePath(paths.directory, true);
    try { await writeFile(paths.control, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    return readControl(paths);
}
export async function readControl(paths: TeamPaths): Promise<string> {
    await privatePath(paths.directory, true);
    await privatePath(paths.control);
    const key = (await readFile(paths.control, "utf8")).trim();
    if (!/^[a-f0-9]{64}$/.test(key)) fail("AUTH", "Invalid broker control credential; preserve runtime data and inspect control.key.");
    return key;
}
