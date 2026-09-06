import path from "node:path";
import { createCommandError } from "../process/command-error.js";
import type { SpawnResult } from "../process/exec-result.js";
import { runCommandBuffered, runCommandWithTimeout, type CommandOptions } from "../process/exec.js";

export const GIT_TIMEOUT_MS = 120_000;

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
    "env" | "input" | "timeoutMs" | "signal" | "killProcessTree" | "maxOutputBytes"
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
  const error = createCommandError(command, result, {
    timeoutMs: result.timeoutMs ?? GIT_TIMEOUT_MS,
  });
  if (result.termination === "timeout") {
    error.message += "\nCheck repository access and disk space.";
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
  options: { env?: NodeJS.ProcessEnv; input?: string | Uint8Array; timeoutMs?: number } = {},
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
  // Required stdout is data, not a diagnostic tail; a clean exit cannot make it complete.
  if (result.code === 0 && result.stdoutTruncatedBytes) {
    throw createError(command, { ...result, code: null, outputLimitExceeded: true });
  }
  if (result.code !== 0) {
    throw createError(command, result);
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
  if (result.code !== 0) {
    throw createGitCommandError(`git ${args.join(" ")}`, result);
  }
  return result.stdout;
}
