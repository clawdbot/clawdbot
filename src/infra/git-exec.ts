import { createCommandError } from "../process/command-error.js";
import type { SpawnResult } from "../process/exec-result.js";
import { runCommandBuffered, runCommandWithTimeout } from "../process/exec.js";

export const GIT_TIMEOUT_MS = 120_000;

export async function executeGitCommand(
  cwd: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    input?: string | Uint8Array;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<SpawnResult & { timeoutMs: number }> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const result = await runCommandWithTimeout(["git", "-C", cwd, ...args], {
    timeoutMs,
    env: options.env,
    input: options.input,
    signal: options.signal,
  });
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
  const result = await executeGitCommand(cwd, args, options);
  if (result.code !== 0) {
    throw createGitCommandError(`git ${args.join(" ")}`, result);
  }
  return result.stdout.trim();
}

export async function requireGitCommandRaw(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string | Uint8Array } = {},
): Promise<string> {
  const result = await executeGitCommand(cwd, args, options);
  if (result.code !== 0) {
    throw createGitCommandError(`git ${args.join(" ")}`, result);
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
