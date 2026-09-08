import fs from "node:fs/promises";
import path from "node:path";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { createCommandError } from "../process/command-error.js";
import type { SpawnResult } from "../process/exec-result.js";
import { runCommandBuffered, runCommandWithTimeout, type CommandOptions } from "../process/exec.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export const GIT_TIMEOUT_MS = 120_000;
// Keep live writers ordered across runtime chunks and shutdown. Settled tails
// remove themselves; resetting this queue would release already-owned cleanup.
const gitRefMutations = resolveGlobalSingleton(
  Symbol.for("openclaw.gitRefMutations"),
  () => new KeyedAsyncQueue(),
);

export async function enqueueGitRefMutation<T>(
  cwd: string,
  commonDirectory: string,
  run: () => Promise<T>,
): Promise<T> {
  const commonPath = normalizeGitPathForFilesystem(commonDirectory);
  const commonDir = await fs.realpath(path.resolve(cwd, commonPath));
  const key = process.platform === "win32" ? commonDir.toLowerCase() : commonDir;
  // Even deleting a loose ref locks shared packed-refs. Queue every ref owner
  // across linked worktrees; external contention retains its native error.
  return await gitRefMutations.enqueue(key, run);
}

type GitCommandResult = SpawnResult & { timeoutMs: number };

export function normalizeGitPathForFilesystem(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") {
    return value;
  }
  // Translate only path-typed Git output at its filesystem boundary. Native
  // paths must stay untouched because C:\c\... can be a real Windows path.
  const match = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(value);
  const drive = match?.[1];
  if (!drive) {
    return value;
  }
  return path.win32.normalize(`${drive.toUpperCase()}:/${match[2] ?? ""}`);
}

export function withForegroundGitMaintenance(argv: string[]): string[] {
  // Maintenance and legacy auto-GC must stay in their cancellable process tree.
  return argv[0] === "git"
    ? ["git", "-c", "maintenance.autoDetach=false", "-c", "gc.autoDetach=false", ...argv.slice(1)]
    : argv;
}

export async function executeGitCommand(
  cwd: string,
  args: string[],
  options: Pick<
    CommandOptions,
    "baseEnv" | "env" | "input" | "timeoutMs" | "signal" | "killProcessTree" | "maxOutputBytes"
  > = {},
): Promise<GitCommandResult> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const argv = ["git", "-C", cwd, ...args];
  const result = await runCommandWithTimeout(
    options.killProcessTree ? withForegroundGitMaintenance(argv) : argv,
    { ...options, timeoutMs },
  );
  return { ...result, timeoutMs };
}

export function createGitCommandError(
  command: string,
  result: (SpawnResult | Awaited<ReturnType<typeof runCommandBuffered>>) & { timeoutMs?: number },
): Error {
  // Buffered Git uses the fixed default; text results carry their applied budget.
  const timeoutMs = result.timeoutMs ?? GIT_TIMEOUT_MS;
  const error = createCommandError(command, result, {
    timeoutMs,
  });
  if (result.termination === "timeout") {
    error.message += `\nGit did not finish within its ${timeoutMs / 1000}s budget; check remote reachability, repository locks, and clone shape (partial clones fetch missing objects lazily).`;
  }
  return error;
}

export async function requireGitCommand(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string | Uint8Array; timeoutMs?: number } = {},
): Promise<string> {
  return (await requireGitCommandRaw(cwd, args, options)).trim();
}

export async function requireGitCommandRaw(
  cwd: string,
  args: string[],
  options: Parameters<typeof requireGitCommand>[2] = {},
): Promise<string> {
  return requireGitCommandOutput(
    `git ${args.join(" ")}`,
    await executeGitCommand(cwd, args, options),
  );
}

export function requireGitCommandOutput(
  command: string,
  result: GitCommandResult,
  createError: (command: string, result: GitCommandResult) => Error = createGitCommandError,
): string {
  if (result.termination !== "exit" || result.code !== 0) {
    throw createError(command, result);
  }
  // Required stdout is data, not a diagnostic tail; a clean exit cannot make it complete.
  if (result.stdoutTruncatedBytes) {
    throw createError(command, { ...result, code: null, outputLimitExceeded: true });
  }
  return result.stdout;
}

export async function requireGitCommandBuffer(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: Uint8Array; maxOutputBytes?: number } = {},
): Promise<Buffer> {
  const result = await runCommandBuffered(["git", "-C", cwd, ...args], {
    timeoutMs: GIT_TIMEOUT_MS,
    env: options.env,
    input: options.input,
    ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
  });
  if (result.termination !== "exit" || result.code !== 0) {
    throw createGitCommandError(`git ${args.join(" ")}`, result);
  }
  return result.stdout;
}
