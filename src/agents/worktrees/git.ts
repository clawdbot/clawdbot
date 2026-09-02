import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createGitCommandError,
  enqueueGitRefMutation,
  executeGitCommand,
  requireGitCommandBuffer,
  requireGitCommandRaw,
} from "../../infra/git-exec.js";

export type GitResult = Awaited<ReturnType<typeof executeGitCommand>>;

type WorktreeListEntry = {
  path: string;
  lockedReason?: string;
};

/**
 * Gateway-run Git must never execute repository hooks or filesystem monitors;
 * the admin-gated setup script is the sole intentional repository-code path.
 * Exported so other Gateway-owned callers that must bypass the `runGit`/
 * `requireGit*` wrappers (e.g. a buffered, non-throwing invocation with a
 * custom timeout) still pin the same invariant instead of reimplementing it.
 */
export function gitEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...(env ?? process.env),
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: os.devNull,
    GIT_CONFIG_KEY_1: "core.fsmonitor",
    GIT_CONFIG_VALUE_1: "false",
  };
}

export async function runGit(
  cwd: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    input?: string | Uint8Array;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<GitResult> {
  const env = gitEnvironment(options.env);
  const run = (gitArgs: string[], baseEnv?: NodeJS.ProcessEnv) =>
    executeGitCommand(cwd, gitArgs, {
      ...options,
      baseEnv,
      env,
      input: gitArgs === args ? options.input : undefined,
    });
  const mutatesRefs =
    args[0] === "update-ref" ||
    (args[0] === "branch" &&
      args.some((arg) => arg === "-d" || arg === "-D" || arg === "--delete"));
  if (!mutatesRefs) {
    return await run(args);
  }
  // Discovery and the queued mutation share one captured environment. The
  // executor still checks cancellation when the queued command actually starts.
  const baseEnv = { ...process.env };
  const resolved = await run(["rev-parse", "--git-common-dir"], baseEnv);
  if (resolved.termination !== "exit" || resolved.code !== 0) {
    return resolved;
  }
  return await enqueueGitRefMutation(cwd, resolved.stdout.trim(), () => run(args, baseEnv));
}

export function commandError(command: string, result: GitResult): Error {
  return createGitCommandError(command, result);
}

export async function requireGit(
  cwd: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    input?: string | Uint8Array;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  const result = await runGit(cwd, args, options);
  if (result.termination !== "exit" || result.code !== 0) {
    throw commandError(`git ${args.join(" ")}`, result);
  }
  return result.stdout.trim();
}

export async function requireGitRaw(cwd: string, args: string[]): Promise<string> {
  return await requireGitCommandRaw(cwd, args, { env: gitEnvironment() });
}

export async function requireGitBuffer(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: Uint8Array } = {},
): Promise<Buffer> {
  return await requireGitCommandBuffer(cwd, args, { ...options, env: gitEnvironment(options.env) });
}

function parseWorktreeList(output: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | undefined;
  for (const field of output.split("\0")) {
    if (!field) {
      if (current) {
        entries.push(current);
        current = undefined;
      }
      continue;
    }
    if (field.startsWith("worktree ")) {
      if (current) {
        entries.push(current);
      }
      current = { path: field.slice("worktree ".length) };
    } else if (current && field === "locked") {
      current.lockedReason = "";
    } else if (current && field.startsWith("locked ")) {
      current.lockedReason = field.slice("locked ".length);
    }
  }
  if (current) {
    entries.push(current);
  }
  return entries;
}

export async function listGitWorktrees(repoRoot: string): Promise<WorktreeListEntry[]> {
  return parseWorktreeList(
    await requireGitRaw(repoRoot, ["worktree", "list", "--porcelain", "-z"]),
  );
}

/**
 * True when dir sits inside a git checkout: a .git entry on itself or any ancestor.
 * Existence, not directory-ness, is the signal — linked worktrees keep a .git file.
 * Mirrors `git rev-parse --show-toplevel` discovery without spawning git, so UI
 * capability checks and create-preflights cannot diverge from the worktree service.
 */
export function findGitCheckoutRoot(start: string): string | null {
  let current = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function insideGitCheckout(start: string): boolean {
  return findGitCheckoutRoot(start) !== null;
}

export async function hasSelfContainedGitMetadata(checkoutRoot: string): Promise<boolean> {
  try {
    const marker = await fs.lstat(path.join(checkoutRoot, ".git"));
    return marker.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function worktreePathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
