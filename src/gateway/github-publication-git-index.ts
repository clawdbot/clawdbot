import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gitNullConfigPath } from "../infra/git-exec.js";
import { GitHubPublicationWorkspaceChangedError } from "./github-publication-failure.js";

type GitCommandOptions = { cwd?: string; env?: NodeJS.ProcessEnv; input?: string };

const HARDENED_GIT = ["git", "-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false"];

class GitHubPublicationRefCasRejectedError extends GitHubPublicationWorkspaceChangedError {}
export class GitHubPublicationRecoveryPendingError extends Error {}

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
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (process.platform !== "win32" || (code !== "EINVAL" && code !== "EPERM")) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

async function sameFile(left: string, right: string): Promise<boolean> {
  try {
    const [leftStat, rightStat] = await Promise.all([fs.stat(left), fs.stat(right)]);
    return (
      leftStat.nlink >= 2 &&
      rightStat.nlink >= 2 &&
      leftStat.dev === rightStat.dev &&
      leftStat.ino === rightStat.ino
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function writeDurableFile(file: string, contents: Buffer): Promise<void> {
  await fs.writeFile(file, contents, { flag: "w", mode: 0o600 });
  const handle = await fs.open(file, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function publicationRecoveryPath(indexPath: string, requestId: string): string {
  const recoveryId = createHash("sha256").update(requestId).digest("hex");
  return `${indexPath}.openclaw-${recoveryId}`;
}

export async function recoverGitHubPublicationBranchAndIndex(params: {
  cwd: string;
  requestId: string;
  branch: string;
  sourceHeadCommit: string;
  workspaceTree: string;
  assertCurrent: () => void;
  run: (argv: string[], options?: GitCommandOptions) => Promise<string>;
}): Promise<void> {
  const mutate = async <T>(operation: () => Promise<T>): Promise<T> => {
    params.assertCurrent();
    return await operation();
  };
  const rawIndexPath = await params.run(["git", "rev-parse", "--git-path", "index"], {
    cwd: params.cwd,
  });
  const indexPath = path.resolve(params.cwd, rawIndexPath);
  const lockPath = `${indexPath}.lock`;
  const recoveryPath = publicationRecoveryPath(indexPath, params.requestId);
  if (!(await pathExists(recoveryPath))) {
    return;
  }
  if (!(await sameFile(recoveryPath, lockPath))) {
    if (await pathExists(lockPath)) {
      throw new GitHubPublicationRecoveryPendingError(
        "GitHub publication workspace recovery is waiting for another Git operation.",
      );
    }
    const branchHead = await params.run(
      ["git", "rev-parse", "--verify", `refs/heads/${params.branch}`],
      { cwd: params.cwd },
    );
    const indexTree = await params.run([...HARDENED_GIT, "write-tree"], { cwd: params.cwd });
    if (
      branchHead === params.sourceHeadCommit ||
      (indexTree === params.workspaceTree && (await publicationCommitMatches(params, branchHead)))
    ) {
      await mutate(async () => await fs.rm(recoveryPath, { force: true }));
      return;
    }
    throw new GitHubPublicationRecoveryPendingError(
      "GitHub publication workspace recovery is pending.",
    );
  }
  const branchHead = await params.run(
    ["git", "rev-parse", "--verify", `refs/heads/${params.branch}`],
    { cwd: params.cwd },
  );
  if (branchHead === params.sourceHeadCommit) {
    await mutate(async () => await fs.rm(lockPath, { force: true }));
    await mutate(async () => await fs.rm(recoveryPath, { force: true }));
    await syncDirectory(path.dirname(indexPath));
    return;
  }
  if (!(await publicationCommitMatches(params, branchHead))) {
    throw new GitHubPublicationRecoveryPendingError(
      "GitHub publication workspace branch recovery is pending.",
    );
  }
  await mutate(async () => await fs.rename(lockPath, indexPath));
  await syncDirectory(path.dirname(indexPath));
  await mutate(async () => await fs.rm(recoveryPath, { force: true }));
}

async function publicationCommitMatches(
  params: Pick<
    Parameters<typeof recoverGitHubPublicationBranchAndIndex>[0],
    "cwd" | "requestId" | "sourceHeadCommit" | "workspaceTree" | "run"
  >,
  headCommit: string,
): Promise<boolean> {
  const [message, parent, tree] = await Promise.all([
    params.run(["git", "show", "-s", "--format=%B", headCommit], { cwd: params.cwd }),
    params.run(["git", "rev-parse", `${headCommit}^`], { cwd: params.cwd }),
    params.run(["git", "rev-parse", `${headCommit}^{tree}`], { cwd: params.cwd }),
  ]);
  return (
    message.split(/\r?\n/u).includes(`OpenClaw-Publication: ${params.requestId}`) &&
    parent === params.sourceHeadCommit &&
    tree === params.workspaceTree
  );
}

/** Moves the branch and accepted index together while honoring Git's standard index lock. */
export async function updateGitHubPublicationBranchAndIndex(params: {
  cwd: string;
  requestId: string;
  branch: string;
  previousHead: string;
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
  let lockPath: string | undefined;
  let recoveryPath: string | undefined;
  let ownsLock = false;
  let refMayHaveMoved = false;
  let installed = false;
  try {
    const rawIndexPath = await params.run(["git", "rev-parse", "--git-path", "index"], {
      cwd: params.cwd,
    });
    const indexPath = path.resolve(params.cwd, rawIndexPath);
    lockPath = `${indexPath}.lock`;
    recoveryPath = publicationRecoveryPath(indexPath, params.requestId);
    const gitEnv = {
      ...params.env,
      GIT_CONFIG_GLOBAL: gitNullConfigPath(),
      GIT_CONFIG_SYSTEM: gitNullConfigPath(),
    };
    await params.run([...HARDENED_GIT, "read-tree", params.headCommit], {
      cwd: params.cwd,
      env: { ...gitEnv, GIT_INDEX_FILE: replacementIndex },
    });
    const replacement = await fs.readFile(replacementIndex);
    let recoveryIndex: Buffer | undefined;
    try {
      recoveryIndex = await fs.readFile(recoveryPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
    }
    if (recoveryIndex && !recoveryIndex.equals(replacement)) {
      const branchHead = await params.run(
        ["git", "rev-parse", "--verify", `refs/heads/${params.branch}`],
        { cwd: params.cwd },
      );
      if ((await sameFile(recoveryPath, lockPath)) || branchHead !== params.previousHead) {
        throw new GitHubPublicationRecoveryPendingError(
          "GitHub publication workspace recovery data changed.",
        );
      }
      recoveryIndex = undefined;
    }
    if (!recoveryIndex) {
      await writeDurableFile(recoveryPath, replacement);
      await syncDirectory(path.dirname(indexPath));
    }
    if (await sameFile(recoveryPath, lockPath)) {
      const branchHead = await params.run(
        ["git", "rev-parse", "--verify", `refs/heads/${params.branch}`],
        { cwd: params.cwd },
      );
      if (branchHead === params.headCommit) {
        try {
          await fs.rename(lockPath, indexPath);
          installed = true;
          await syncDirectory(path.dirname(indexPath));
          await fs.rm(recoveryPath, { force: true });
          return;
        } catch (error) {
          throw new GitHubPublicationRecoveryPendingError(
            "GitHub publication workspace index recovery is pending.",
            { cause: error },
          );
        }
      }
      if (branchHead !== params.previousHead) {
        throw new GitHubPublicationRecoveryPendingError(
          "GitHub publication workspace branch recovery is pending.",
        );
      }
      await fs.rm(lockPath);
      await syncDirectory(path.dirname(indexPath));
    } else if (await pathExists(lockPath)) {
      throw new Error("GitHub publication workspace index is locked by another operation.");
    }
    params.assertCurrent();
    try {
      await fs.link(recoveryPath, lockPath);
      ownsLock = true;
    } catch (error) {
      throw new Error("GitHub publication workspace index changed before commit.", {
        cause: error,
      });
    }
    await fs.copyFile(indexPath, observedIndex);
    const currentIndexTree = await params.run([...HARDENED_GIT, "write-tree"], {
      cwd: params.cwd,
      env: { ...gitEnv, GIT_INDEX_FILE: observedIndex },
    });
    if (currentIndexTree !== params.sourceIndexTree && currentIndexTree !== params.workspaceTree) {
      throw new GitHubPublicationWorkspaceChangedError(
        "GitHub publication workspace index changed after its accepted snapshot.",
      );
    }
    params.assertCurrent();
    // The request-owned recovery inode proves whether a retained standard Git
    // lock belongs to this transaction; matching bytes alone never claim it.
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
    await fs.rename(lockPath, indexPath);
    ownsLock = false;
    installed = true;
    await syncDirectory(path.dirname(indexPath));
    await fs.rm(recoveryPath, { force: true });
  } catch (error) {
    if (!installed && refMayHaveMoved && ownsLock) {
      throw new GitHubPublicationRecoveryPendingError(
        "GitHub publication workspace recovery is pending.",
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (!installed && !refMayHaveMoved && ownsLock && lockPath) {
      await fs.rm(lockPath, { force: true });
    }
    if ((installed || !refMayHaveMoved) && recoveryPath) {
      await fs.rm(recoveryPath, { force: true });
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
