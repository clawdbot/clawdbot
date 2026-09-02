import os from "node:os";
import { enqueueGitRefMutation } from "../../infra/git-exec.js";
import { runCommandWithTimeout } from "../../process/exec.js";

export const WORKSPACE_RESULT_GIT_TIMEOUT_MS = 10 * 60_000;

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
  options: { input?: Uint8Array; baseEnv?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const result = await runCommandWithTimeout(workspaceResultGitCommand(cwd, args), {
    timeoutMs: WORKSPACE_RESULT_GIT_TIMEOUT_MS,
    maxOutputBytes: 1024 * 1024,
    baseEnv: options.baseEnv,
    input: options.input,
  });
  if (result.termination !== "exit" || result.code !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  }
  return result.stdout.trim();
}

export async function withWorkspaceResultRefMutation<T>(
  root: string,
  operation: (baseEnv: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  // Git environment can redirect discovery or a queued writer; bind both to
  // the same snapshot while keeping the worker's timeout and byte contracts.
  const baseEnv = { ...process.env };
  const common = await requireWorkspaceResultGit(root, ["rev-parse", "--git-common-dir"], {
    baseEnv,
  });
  return await enqueueGitRefMutation(root, common, () => operation(baseEnv));
}

type WorkspaceResultRefUpdate = { ref: string; objectId?: string };

/** Atomically moves/deletes result refs before their caller changes its durable fence. */
export async function updateWorkspaceResultRefs(
  root: string,
  updates: readonly WorkspaceResultRefUpdate[] | (() => readonly WorkspaceResultRefUpdate[]),
): Promise<void> {
  await withWorkspaceResultRefMutation(root, async (baseEnv) => {
    const current = typeof updates === "function" ? updates() : updates;
    if (current.length === 0) {
      return;
    }
    const input = current
      .map(({ ref, objectId }) =>
        objectId === undefined ? `delete ${ref}\0\0` : `update ${ref}\0${objectId}\0\0`,
      )
      .join("");
    await requireWorkspaceResultGit(root, ["update-ref", "--stdin", "-z"], {
      input: Buffer.from(input),
      baseEnv,
    });
  });
}
