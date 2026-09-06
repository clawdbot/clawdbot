import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

export const WORKSPACE_RESULT_GIT_TIMEOUT_MS = 10 * 60_000;

// Settled tails remove themselves. Do not reset a live queue during shutdown:
// already-owned result cleanup must retain its ordering until Git has exited.
const refOperations = resolveGlobalSingleton(
  Symbol.for("openclaw.workerWorkspaceResultRefOperations"),
  () => new KeyedAsyncQueue(),
);

export function workspaceResultGitCommand(cwd: string, args: string[]): string[] {
  return [
    "git",
    "-c",
    // The platform null device disables hooks without trusting an unowned path.
    `core.hooksPath=${os.devNull}`,
    "-c",
    "core.fsmonitor=false",
    "-C",
    cwd,
    ...args,
  ];
}

export async function requireWorkspaceResultGit(
  cwd: string,
  args: string[],
  input?: Uint8Array,
): Promise<string> {
  const result = await runCommandWithTimeout(workspaceResultGitCommand(cwd, args), {
    timeoutMs: WORKSPACE_RESULT_GIT_TIMEOUT_MS,
    maxOutputBytes: 1024 * 1024,
    ...(input ? { input } : {}),
  });
  if (result.termination !== "exit" || result.code !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  }
  return result.stdout.trim();
}

export async function withWorkspaceResultRefMutation<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const common = await requireWorkspaceResultGit(root, ["rev-parse", "--git-common-dir"]);
  const commonDir = await fs.realpath(path.resolve(root, common));
  // Linked worktrees share packed-refs. Even deleting a loose ref locks that
  // shared file, so distinct environment/worktree keys cannot protect it.
  return await refOperations.enqueue(commonDir, operation);
}

type WorkspaceResultRefUpdate = { ref: string; objectId?: string };

/** Atomically moves/deletes result refs before their caller changes its durable fence. */
export async function updateWorkspaceResultRefs(
  root: string,
  updates: readonly WorkspaceResultRefUpdate[] | (() => readonly WorkspaceResultRefUpdate[]),
): Promise<void> {
  await withWorkspaceResultRefMutation(root, async () => {
    const current = typeof updates === "function" ? updates() : updates;
    if (current.length === 0) {
      return;
    }
    const input = current
      .map(({ ref, objectId }) =>
        objectId === undefined ? `delete ${ref}\0\0` : `update ${ref}\0${objectId}\0\0`,
      )
      .join("");
    await requireWorkspaceResultGit(root, ["update-ref", "--stdin", "-z"], Buffer.from(input));
  });
}
