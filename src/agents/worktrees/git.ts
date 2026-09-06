import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createGitCommandError,
  executeGitCommand,
  normalizeGitPathForFilesystem,
  requireGitCommand,
  requireGitCommandBuffer,
  requireGitCommandRaw,
} from "../../infra/git-exec.js";
import { mergeProcessEnv, resolveEnvironmentValue } from "../../infra/process-env.js";

export type GitResult = Awaited<ReturnType<typeof executeGitCommand>>;

type WorktreeListEntry = {
  path: string;
  lockedReason?: string;
};

function withNoGlob(value: string | undefined): string {
  if (value?.trim().split(/\s+/).at(-1) === "noglob") {
    return value;
  }
  return value ? `${value} noglob` : "noglob";
}

/**
 * Gateway-run Git must never execute repository hooks or filesystem monitors;
 * the admin-gated setup script is the sole intentional repository-code path.
 * Exported so other Gateway-owned callers that must bypass the `runGit`/
 * `requireGit*` wrappers (e.g. a buffered, non-throwing invocation with a
 * custom timeout) still pin the same invariant instead of reimplementing it.
 */
export function gitEnvironment(
  env?: NodeJS.ProcessEnv,
  args: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const baseEnv = env ?? inheritedEnv;
  // Callers may supply only Git-specific overrides. Resolve against the inherited
  // child environment first so preserving revision arguments cannot discard policy.
  const effectiveWindowsEnv =
    platform === "win32" && args.some((arg) => arg.endsWith("^{commit}"))
      ? mergeProcessEnv([inheritedEnv, env], platform)
      : undefined;
  const windowsNoGlob = effectiveWindowsEnv
    ? {
        // MSYS2/Cygwin expand braces before Git sees argv. Keep revision
        // expressions such as HEAD^{commit} literal within this Git owner.
        MSYS: withNoGlob(resolveEnvironmentValue(effectiveWindowsEnv, "MSYS", platform)),
        CYGWIN: withNoGlob(resolveEnvironmentValue(effectiveWindowsEnv, "CYGWIN", platform)),
      }
    : {};
  return {
    ...baseEnv,
    ...windowsNoGlob,
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
  return await executeGitCommand(cwd, args, { ...options, env: gitEnvironment(options.env, args) });
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
  return await requireGitCommand(cwd, args, { ...options, env: gitEnvironment(options.env, args) });
}

export async function requireGitRaw(cwd: string, args: string[]): Promise<string> {
  return await requireGitCommandRaw(cwd, args, { env: gitEnvironment(undefined, args) });
}

export async function requireGitBuffer(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: Uint8Array } = {},
): Promise<Buffer> {
  return await requireGitCommandBuffer(cwd, args, {
    ...options,
    env: gitEnvironment(options.env, args),
  });
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
      current = {
        path: normalizeGitPathForFilesystem(field.slice("worktree ".length)),
      };
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
