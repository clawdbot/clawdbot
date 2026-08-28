import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { runCommandBuffered, runCommandWithTimeout, type SpawnResult } from "../process/exec.js";

export const GIT_TIMEOUT_MS = 120_000;

export async function executeGitCommand(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string | Uint8Array } = {},
): Promise<SpawnResult> {
  return await runCommandWithTimeout(["git", "-C", cwd, ...args], {
    timeoutMs: GIT_TIMEOUT_MS,
    env: options.env,
    input: options.input,
  });
}

export function createGitCommandError(
  command: string,
  result: SpawnResult | Awaited<ReturnType<typeof runCommandBuffered>>,
): Error {
  const output = stripAnsi(result.stderr.toString()).trim() || stripAnsi(result.stdout.toString());
  // Git progress redraws use CR, not LF. Keep the last frame of each line,
  // including an unfinished redraw, without changing successful command output.
  const normalized = output
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\r+$/, "").split("\r").at(-1) ?? "")
    .join("\n")
    .trim();
  const tail = normalized.split("\n").slice(-12).join("\n");
  const omitted = tail.length < normalized.length || tail.length > 2000;
  const detail = `${omitted ? "…\n" : ""}${sliceUtf16Safe(tail, -2000)}`;
  const reasons: string[] = [];
  const timedOut = result.termination === "timeout";
  if (timedOut) {
    reasons.push(`timed out after ${GIT_TIMEOUT_MS / 1000} seconds`);
  } else if (result.termination === "no-output-timeout") {
    reasons.push("timed out waiting for output");
  } else if (
    result.termination === "output-limit" ||
    ("outputLimitExceeded" in result && result.outputLimitExceeded)
  ) {
    reasons.push("output limit exceeded");
  }
  if (result.signal) {
    reasons.push(`signal ${result.signal}`);
  } else if (result.termination === "signal" && reasons.length === 0) {
    reasons.push("terminated");
  }
  if (reasons.length === 0 && result.code !== null) {
    reasons.push(`exit code ${result.code}`);
  }
  const label = truncateUtf16Safe(stripAnsi(command).replace(/[\r\n]+/g, " "), 256);
  const reason = reasons.length > 0 ? ` (${reasons.join("; ")})` : "";
  const nextStep = timedOut ? "\nCheck repository access and disk space." : "";
  return new Error(`${label} failed${reason}${detail ? `:\n${detail}` : ""}${nextStep}`);
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
