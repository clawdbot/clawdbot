import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type GitCommandOptions = { cwd?: string; env?: NodeJS.ProcessEnv; input?: string };

export class GitHubPublicationRefCasRejectedError extends Error {}

export function assertGitHubPublicationRefCasCompleted(result: {
  code: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
}): void {
  if (result.code === 0) {
    return;
  }
  if (result.signal === null && !result.killed) {
    throw new GitHubPublicationRefCasRejectedError(
      "GitHub publication workspace branch changed before commit.",
    );
  }
  throw new Error("GitHub publication workspace branch update outcome is unknown.");
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EINVAL" && code !== "EPERM")) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Moves the branch and accepted index together while honoring Git's standard index lock. */
export async function updateGitHubPublicationBranchAndIndex(params: {
  cwd: string;
  sourceIndexTree: string;
  workspaceTree: string;
  headCommit: string;
  env: NodeJS.ProcessEnv;
  assertCurrent: () => void;
  run: (argv: string[], options?: GitCommandOptions) => Promise<string>;
  updateRef?: () => Promise<void>;
}): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-github-index-"));
  const replacementIndex = path.join(tempDir, "replacement-index");
  const observedIndex = path.join(tempDir, "observed-index");
  let lock: FileHandle | undefined;
  let lockPath: string | undefined;
  let ownsLock = false;
  let refMayHaveMoved = false;
  let installed = false;
  try {
    const rawIndexPath = await params.run(["git", "rev-parse", "--git-path", "index"], {
      cwd: params.cwd,
    });
    const indexPath = path.resolve(params.cwd, rawIndexPath);
    lockPath = `${indexPath}.lock`;
    const gitEnv = {
      ...params.env,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_SYSTEM: os.devNull,
    };
    const hardenedGit = ["git", "-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false"];
    await params.run([...hardenedGit, "read-tree", params.headCommit], {
      cwd: params.cwd,
      env: { ...gitEnv, GIT_INDEX_FILE: replacementIndex },
    });
    const replacement = await fs.readFile(replacementIndex);
    params.assertCurrent();
    try {
      lock = await fs.open(lockPath, "wx", 0o600);
      ownsLock = true;
    } catch (error) {
      throw new Error("GitHub publication workspace index changed before commit.", {
        cause: error,
      });
    }
    await fs.copyFile(indexPath, observedIndex);
    const currentIndexTree = await params.run([...hardenedGit, "write-tree"], {
      cwd: params.cwd,
      env: { ...gitEnv, GIT_INDEX_FILE: observedIndex },
    });
    if (currentIndexTree !== params.sourceIndexTree && currentIndexTree !== params.workspaceTree) {
      throw new Error("GitHub publication workspace index changed after its accepted snapshot.");
    }
    params.assertCurrent();
    // Prepare durable recovery bytes before the ref CAS. A crash afterward leaves
    // a complete Git lock that can be inspected/recovered, never an empty blocker.
    await lock.writeFile(replacement);
    await lock.sync();
    await syncDirectory(path.dirname(indexPath));
    params.assertCurrent();
    if (params.updateRef) {
      refMayHaveMoved = true;
      try {
        await params.updateRef();
      } catch (error) {
        if (error instanceof GitHubPublicationRefCasRejectedError) {
          refMayHaveMoved = false;
        }
        throw error;
      }
    }
    params.assertCurrent();
    await lock.close();
    lock = undefined;
    await fs.rename(lockPath, indexPath);
    ownsLock = false;
    installed = true;
    await syncDirectory(path.dirname(indexPath));
  } finally {
    await lock?.close().catch(() => undefined);
    if (!installed && !refMayHaveMoved && ownsLock && lockPath) {
      await fs.rm(lockPath, { force: true });
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
