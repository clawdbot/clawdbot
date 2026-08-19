import { runCommandBuffered, runCommandWithTimeout } from "../process/exec.js";

export const GIT_TIMEOUT_MS = 120_000;

type GitCommandResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

export async function executeGitCommand(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string | Uint8Array } = {},
): Promise<GitCommandResult> {
  return await runCommandWithTimeout(["git", "-C", cwd, ...args], {
    timeoutMs: GIT_TIMEOUT_MS,
    env: options.env,
    input: options.input,
  });
}

export function createGitCommandError(command: string, result: GitCommandResult): Error {
  const detail = (result.stderr || result.stdout).trim().split("\n").slice(-12).join("\n");
  return new Error(`${command} failed${detail ? `:\n${detail}` : ""}`);
}

export async function requireGitCommand(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string | Uint8Array } = {},
): Promise<string> {
  const result = await executeGitCommand(cwd, args, options);
  if (result.code !== 0) {
    throw createGitCommandError(`git ${args.join(" ")}`, result);
  }
  return result.stdout.trim();
}

export async function requireGitCommandRaw(cwd: string, args: string[]): Promise<string> {
  const result = await executeGitCommand(cwd, args);
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
    const detail = (result.stderr.length > 0 ? result.stderr : result.stdout)
      .toString("utf8")
      .trim()
      .split("\n")
      .slice(-12)
      .join("\n");
    throw new Error(`git ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout;
}
