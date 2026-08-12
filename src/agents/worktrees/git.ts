import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createGitCommandError,
  executeGitCommand,
  requireGitCommand,
  requireGitCommandBuffer,
  requireGitCommandRaw,
} from "../../infra/git-exec.js";

export type GitResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

type WorktreeListEntry = {
  path: string;
  lockedReason?: string;
};

// Preserve the worktree-facing dependency contract while generic Git execution
// remains owned by infra/git-exec.
export async function runGit(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string | Uint8Array } = {},
): Promise<GitResult> {
  return await executeGitCommand(cwd, args, options);
}

export function commandError(command: string, result: GitResult): Error {
  return createGitCommandError(command, result);
}

export async function requireGit(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string | Uint8Array } = {},
): Promise<string> {
  return await requireGitCommand(cwd, args, options);
}

export async function requireGitRaw(cwd: string, args: string[]): Promise<string> {
  return await requireGitCommandRaw(cwd, args);
}

export async function requireGitBuffer(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: Uint8Array } = {},
): Promise<Buffer> {
  return await requireGitCommandBuffer(cwd, args, options);
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

export async function removeEmptyParents(start: string, stop: string): Promise<void> {
  let current = start;
  while (current.startsWith(`${stop}${path.sep}`)) {
    try {
      await fs.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}
