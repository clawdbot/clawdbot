import { runCommandBuffered, runCommandWithTimeout } from "../process/exec.js";

const GIT_TIMEOUT_MS = 120_000;

export type GitResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

export async function runGit(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string | Uint8Array } = {},
): Promise<GitResult> {
  return await runCommandWithTimeout(["git", "-C", cwd, ...args], {
    timeoutMs: GIT_TIMEOUT_MS,
    env: options.env,
    input: options.input,
  });
}

export function commandError(command: string, result: GitResult): Error {
  const detail = (result.stderr || result.stdout).trim().split("\n").slice(-12).join("\n");
  return new Error(`${command} failed${detail ? `:\n${detail}` : ""}`);
}

export async function requireGit(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string | Uint8Array } = {},
): Promise<string> {
  const result = await runGit(cwd, args, options);
  if (result.code !== 0) {
    throw commandError(`git ${args.join(" ")}`, result);
  }
  return result.stdout.trim();
}

export async function requireGitRaw(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.code !== 0) {
    throw commandError(`git ${args.join(" ")}`, result);
  }
  return result.stdout;
}

export async function requireGitBuffer(
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
