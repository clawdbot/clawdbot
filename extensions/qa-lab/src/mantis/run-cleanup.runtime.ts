// Qa Lab plugin module owns bounded Mantis worktree cleanup.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertNoSymlinkParents, root } from "openclaw/plugin-sdk/security-runtime";
import {
  runMantisCommand,
  type MantisCommandExecution,
  type MantisCommandResult,
  type MantisCommandRunner,
  type MantisCommandTimeouts,
} from "./run-command.runtime.js";
import { hasSameFileIdentity, type MantisDirectoryOwnership } from "./run-directory.runtime.js";

type MantisCleanupRoot = Pick<
  Awaited<ReturnType<typeof root>>,
  "exists" | "list" | "move" | "remove" | "stat"
>;
type MantisCleanupRootFactory = (rootDir: string) => Promise<MantisCleanupRoot>;

type MantisCleanupDeadline = {
  expiresAtMs: number;
  lane: "baseline" | "candidate" | "run";
  timeoutMs: number;
};

class MantisCleanupDeadlineError extends Error {
  constructor(deadline: MantisCleanupDeadline, operation: string, cause?: unknown) {
    super(
      `${deadline.lane} worktree cleanup exceeded its total ${deadline.timeoutMs}ms deadline while ${operation}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "MantisCleanupDeadlineError";
  }
}

function createMantisCleanupDeadline(params: {
  lane: "baseline" | "candidate" | "run";
  timeoutMs: number;
}): MantisCleanupDeadline {
  return {
    expiresAtMs: Date.now() + params.timeoutMs,
    lane: params.lane,
    timeoutMs: params.timeoutMs,
  };
}

function resolveMantisCleanupRemainingMs(
  deadline: MantisCleanupDeadline,
  operation: string,
): number {
  const remainingMs = deadline.expiresAtMs - Date.now();
  if (remainingMs <= 0) {
    throw new MantisCleanupDeadlineError(deadline, operation);
  }
  return Math.max(1, Math.ceil(remainingMs));
}

async function runBeforeMantisCleanupDeadline<T>(
  deadline: MantisCleanupDeadline,
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  const remainingMs = resolveMantisCleanupRemainingMs(deadline, operation);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new MantisCleanupDeadlineError(deadline, operation)),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function runMantisCleanupMutation<T>(
  deadline: MantisCleanupDeadline,
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  resolveMantisCleanupRemainingMs(deadline, `starting ${operation}`);
  let result: T;
  try {
    // fs-safe mutations do not accept AbortSignal. Await settlement so Mantis
    // never reports a deadline while a move/remove can still mutate later.
    result = await run();
  } catch (error) {
    if (deadline.expiresAtMs - Date.now() <= 0) {
      throw new MantisCleanupDeadlineError(deadline, `finishing ${operation}`, error);
    }
    throw error;
  }
  resolveMantisCleanupRemainingMs(deadline, `finishing ${operation}`);
  return result;
}

function rethrowMantisCleanupDeadline(error: unknown): void {
  if (error instanceof MantisCleanupDeadlineError) {
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isPathWithinOrEqual(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function verifyMantisDirectoryOwnershipBeforeDeadline(params: {
  directoryPath: string;
  deadline: MantisCleanupDeadline;
  ownership: MantisDirectoryOwnership;
  repoRoot: string;
}): Promise<boolean> {
  // Recheck the owned path immediately before recursive removal; otherwise a
  // replaced parent or target could redirect cleanup outside the Mantis output.
  await runBeforeMantisCleanupDeadline(
    params.deadline,
    "verifying worktree path ownership",
    async () =>
      await assertNoSymlinkParents({
        rootDir: path.resolve(params.repoRoot),
        targetPath: path.resolve(params.directoryPath),
      }),
  );
  let parentStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    parentStat = await runBeforeMantisCleanupDeadline(
      params.deadline,
      "reading the worktree parent identity",
      async () => await fs.lstat(path.dirname(params.directoryPath)),
    );
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
  let targetStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    targetStat = await runBeforeMantisCleanupDeadline(
      params.deadline,
      "reading the worktree identity",
      async () => await fs.lstat(params.directoryPath),
    );
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
  if (
    !hasSameFileIdentity(parentStat, {
      dev: params.ownership.parentDevice,
      ino: params.ownership.parentInode,
    }) ||
    !hasSameFileIdentity(targetStat, {
      dev: params.ownership.targetDevice,
      ino: params.ownership.targetInode,
    })
  ) {
    throw new Error(`Mantis owned path was replaced before cleanup: ${params.directoryPath}`);
  }
  return true;
}

async function removeMantisOwnedDirectoryBeforeDeadline(params: {
  directoryPath: string;
  deadline: MantisCleanupDeadline;
  ownership: MantisDirectoryOwnership;
  repoRoot: string;
  rootFactory: MantisCleanupRootFactory;
}): Promise<void> {
  // Recursive fallback removal stays anchored to the canonical repo root; a raw
  // fs.rm path could follow a swapped parent into an unrelated directory.
  const canonicalRepoRoot = await runBeforeMantisCleanupDeadline(
    params.deadline,
    "resolving the repository root",
    async () => await fs.realpath(path.resolve(params.repoRoot)),
  );
  const directoryPath = path.resolve(params.directoryPath);
  if (!(await verifyMantisDirectoryOwnershipBeforeDeadline(params))) {
    return;
  }
  const canonicalDirectoryPath = await runBeforeMantisCleanupDeadline(
    params.deadline,
    "resolving the unregistered worktree",
    async () => await fs.realpath(directoryPath),
  );
  if (
    canonicalDirectoryPath === canonicalRepoRoot ||
    !isPathWithinOrEqual(canonicalRepoRoot, canonicalDirectoryPath)
  ) {
    throw new Error(`Mantis owned path escaped the repository: ${params.directoryPath}`);
  }

  const relativeDirectoryPath = path
    .relative(canonicalRepoRoot, canonicalDirectoryPath)
    .split(path.sep)
    .join(path.posix.sep);
  const repoRootHandle = await runBeforeMantisCleanupDeadline(
    params.deadline,
    "opening the safe repository root",
    async () => await params.rootFactory(canonicalRepoRoot),
  );
  const quarantineRelativePath = path.posix.join(
    path.posix.dirname(relativeDirectoryPath),
    `.mantis-cleanup-${process.pid}-${randomUUID()}`,
  );
  // fs-safe's Node fallback requires explicit overwrite for directory moves;
  // the UUID quarantine path is fresh and keeps recursive cleanup root-bound.
  await runMantisCleanupMutation(
    params.deadline,
    `quarantining the worktree at ${quarantineRelativePath}`,
    async () =>
      await repoRootHandle.move(relativeDirectoryPath, quarantineRelativePath, {
        overwrite: true,
      }),
  );
  const quarantinedStat = await runBeforeMantisCleanupDeadline(
    params.deadline,
    "verifying the quarantined worktree",
    async () => await repoRootHandle.stat(quarantineRelativePath),
  );
  if (
    quarantinedStat.isSymbolicLink ||
    !hasSameFileIdentity(quarantinedStat, {
      dev: params.ownership.targetDevice,
      ino: params.ownership.targetInode,
    })
  ) {
    throw new Error(`Mantis owned target changed while quarantining ${params.directoryPath}`);
  }
  const removeRelative = async (relativePath: string): Promise<void> => {
    if (
      !(await runBeforeMantisCleanupDeadline(
        params.deadline,
        "checking a quarantined worktree entry",
        async () => await repoRootHandle.exists(relativePath),
      ))
    ) {
      return;
    }
    if (relativePath === quarantineRelativePath) {
      const stat = await runBeforeMantisCleanupDeadline(
        params.deadline,
        "verifying the quarantine before recursive removal",
        async () => await repoRootHandle.stat(relativePath),
      );
      if (
        stat.isSymbolicLink ||
        !hasSameFileIdentity(stat, {
          dev: params.ownership.targetDevice,
          ino: params.ownership.targetInode,
        })
      ) {
        throw new Error(`Mantis worktree quarantine changed before removal: ${relativePath}`);
      }
    }
    let entries: { isDirectory: boolean; isSymbolicLink: boolean; name: string }[];
    try {
      entries = await runBeforeMantisCleanupDeadline(
        params.deadline,
        "listing a quarantined worktree directory",
        async () => await repoRootHandle.list(relativePath, { withFileTypes: true }),
      );
    } catch (error) {
      rethrowMantisCleanupDeadline(error);
      if (
        !(await runBeforeMantisCleanupDeadline(
          params.deadline,
          "rechecking a quarantined worktree entry",
          async () => await repoRootHandle.exists(relativePath),
        ))
      ) {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const childPath = path.posix.join(relativePath, entry.name);
      if (entry.isDirectory && !entry.isSymbolicLink) {
        await removeRelative(childPath);
      } else {
        await runMantisCleanupMutation(
          params.deadline,
          `removing quarantined worktree entry ${childPath}`,
          async () => await repoRootHandle.remove(childPath),
        );
      }
    }
    if (relativePath === quarantineRelativePath) {
      const stat = await runBeforeMantisCleanupDeadline(
        params.deadline,
        "verifying the quarantine after recursive removal",
        async () => await repoRootHandle.stat(relativePath),
      );
      if (
        stat.isSymbolicLink ||
        !hasSameFileIdentity(stat, {
          dev: params.ownership.targetDevice,
          ino: params.ownership.targetInode,
        })
      ) {
        throw new Error(`Mantis worktree quarantine changed during removal: ${relativePath}`);
      }
    }
    await runMantisCleanupMutation(
      params.deadline,
      `removing quarantined worktree directory ${relativePath}`,
      async () => await repoRootHandle.remove(relativePath),
    );
  };

  await removeRelative(quarantineRelativePath);
}

async function normalizeWorktreePath(
  filePath: string,
  repoRoot: string,
  deadline: MantisCleanupDeadline,
): Promise<string> {
  const resolvedPath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(repoRoot, filePath);
  try {
    return await runBeforeMantisCleanupDeadline(
      deadline,
      "normalizing a registered worktree path",
      async () => await fs.realpath(resolvedPath),
    );
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  const resolvedRepoRoot = path.resolve(repoRoot);
  const canonicalRepoRoot = await runBeforeMantisCleanupDeadline(
    deadline,
    "normalizing the repository root",
    async () => await fs.realpath(resolvedRepoRoot),
  );
  if (!isPathWithinOrEqual(resolvedRepoRoot, resolvedPath)) {
    return resolvedPath;
  }
  return path.join(canonicalRepoRoot, path.relative(resolvedRepoRoot, resolvedPath));
}

async function parseRegisteredWorktreePaths(
  stdout: string,
  repoRoot: string,
  nulTerminated: boolean,
  deadline: MantisCleanupDeadline,
): Promise<string[]> {
  const fields = nulTerminated
    ? stdout.split("\0")
    : stdout.split("\n").map((field) => (field.endsWith("\r") ? field.slice(0, -1) : field));
  const entries = fields
    .filter((entry) => entry.startsWith("worktree "))
    .map((entry) => entry.slice("worktree ".length));
  return await Promise.all(
    entries.map((entry) => normalizeWorktreePath(entry, repoRoot, deadline)),
  );
}

async function listRegisteredWorktreePaths(params: {
  createExecution: () => MantisCommandExecution;
  deadline: MantisCleanupDeadline;
  lane: "baseline" | "candidate";
  repoRoot: string;
  runner: MantisCommandRunner;
  worktreeDir: string;
}): Promise<string[]> {
  let listResult: MantisCommandResult;
  let nulTerminated = true;
  try {
    listResult = await runMantisCommand({
      command: "git",
      args: ["worktree", "list", "--porcelain", "-z"],
      execution: params.createExecution(),
      lane: params.lane,
      runner: params.runner,
    });
  } catch (nulListError) {
    rethrowMantisCleanupDeadline(nulListError);
    // Git gained `worktree list -z` in 2.36. Older porcelain is safe for our
    // generated lane path unless an ancestor contains a newline; refuse recursive removal then.
    if (params.worktreeDir.includes("\n")) {
      throw new Error(
        `${params.lane} worktree cleanup cannot verify a newline-containing path with legacy Git`,
        { cause: nulListError },
      );
    }
    listResult = await runMantisCommand({
      command: "git",
      args: ["worktree", "list", "--porcelain"],
      execution: params.createExecution(),
      lane: params.lane,
      runner: params.runner,
    });
    nulTerminated = false;
  }

  if (listResult.stdoutTruncatedBytes) {
    throw new Error(
      `${params.lane} worktree cleanup truncated registration output for ${params.worktreeDir}`,
    );
  }
  return await parseRegisteredWorktreePaths(
    listResult.stdout,
    params.repoRoot,
    nulTerminated,
    params.deadline,
  );
}

function createCleanupVerificationAggregate(params: {
  errors: [unknown, unknown];
  lane: "baseline" | "candidate";
  worktreeDir: string;
}): AggregateError {
  return new AggregateError(
    params.errors,
    `${params.lane} worktree cleanup could not verify complete registration state for ${params.worktreeDir}`,
    { cause: params.errors[0] },
  );
}

function createUnregisteredDirectoryRemovalAggregate(params: {
  errors: [unknown, unknown];
  lane: "baseline" | "candidate";
  worktreeDir: string;
}): AggregateError {
  return new AggregateError(
    params.errors,
    `${params.lane} worktree cleanup could not remove unregistered directory ${params.worktreeDir}`,
    { cause: params.errors[0] },
  );
}

export async function removeMantisOwnedDirectory(params: {
  cleanupExpiresAtMs?: number;
  cleanupTimeoutMs: number;
  directoryPath: string;
  ownership: MantisDirectoryOwnership;
  repoRoot: string;
  rootFactory?: MantisCleanupRootFactory;
}): Promise<void> {
  const deadline = createMantisCleanupDeadline({
    lane: "run",
    timeoutMs: params.cleanupTimeoutMs,
  });
  if (params.cleanupExpiresAtMs !== undefined) {
    deadline.expiresAtMs = params.cleanupExpiresAtMs;
  }
  try {
    await removeMantisOwnedDirectoryBeforeDeadline({
      deadline,
      directoryPath: params.directoryPath,
      ownership: params.ownership,
      repoRoot: params.repoRoot,
      rootFactory: params.rootFactory ?? root,
    });
  } catch (error) {
    rethrowMantisCleanupDeadline(error);
    throw new Error(`Mantis refused to remove changed run directory ${params.directoryPath}`, {
      cause: error,
    });
  }
}

export async function removeMantisEmptyOwnedDirectory(params: {
  cleanupExpiresAtMs?: number;
  cleanupTimeoutMs: number;
  directoryPath: string;
  ownership: MantisDirectoryOwnership;
  repoRoot: string;
  rootFactory?: MantisCleanupRootFactory;
}): Promise<void> {
  const deadline = createMantisCleanupDeadline({
    lane: "run",
    timeoutMs: params.cleanupTimeoutMs,
  });
  if (params.cleanupExpiresAtMs !== undefined) {
    deadline.expiresAtMs = params.cleanupExpiresAtMs;
  }
  const directoryPath = path.resolve(params.directoryPath);
  try {
    if (
      !(await verifyMantisDirectoryOwnershipBeforeDeadline({
        deadline,
        directoryPath,
        ownership: params.ownership,
        repoRoot: params.repoRoot,
      }))
    ) {
      return;
    }
    const canonicalRepoRoot = await runBeforeMantisCleanupDeadline(
      deadline,
      "resolving the repository root",
      async () => await fs.realpath(path.resolve(params.repoRoot)),
    );
    const canonicalDirectoryPath = await runBeforeMantisCleanupDeadline(
      deadline,
      "resolving the owned directory",
      async () => await fs.realpath(directoryPath),
    );
    if (
      canonicalDirectoryPath === canonicalRepoRoot ||
      !isPathWithinOrEqual(canonicalRepoRoot, canonicalDirectoryPath)
    ) {
      throw new Error(`Mantis owned path escaped the repository: ${directoryPath}`);
    }
    const relativeDirectoryPath = path
      .relative(canonicalRepoRoot, canonicalDirectoryPath)
      .split(path.sep)
      .join(path.posix.sep);
    const repoRootHandle = await runBeforeMantisCleanupDeadline(
      deadline,
      "opening the safe repository root",
      async () => await (params.rootFactory ?? root)(canonicalRepoRoot),
    );
    await runMantisCleanupMutation(
      deadline,
      `removing empty owned directory ${relativeDirectoryPath}`,
      async () => await repoRootHandle.remove(relativeDirectoryPath),
    );
    if (
      await verifyMantisDirectoryOwnershipBeforeDeadline({
        deadline,
        directoryPath,
        ownership: params.ownership,
        repoRoot: params.repoRoot,
      })
    ) {
      throw new Error(`Mantis empty-directory cleanup left ${directoryPath}`);
    }
  } catch (error) {
    rethrowMantisCleanupDeadline(error);
    throw new Error(
      `Mantis refused to remove changed or non-empty run directory ${directoryPath}`,
      {
        cause: error,
      },
    );
  }
}

export async function removeMantisWorktree(params: {
  commandTimeouts: MantisCommandTimeouts;
  lane: "baseline" | "candidate";
  repoRoot: string;
  rootFactory?: MantisCleanupRootFactory;
  runner: MantisCommandRunner;
  worktreeDir: string;
  ownership: MantisDirectoryOwnership;
}) {
  const cleanupTimeoutMs = params.commandTimeouts["worktree-cleanup"];
  const deadline = createMantisCleanupDeadline({
    lane: params.lane,
    timeoutMs: cleanupTimeoutMs,
  });
  const createCleanupExecution = (): MantisCommandExecution => ({
    cwd: params.repoRoot,
    env: process.env,
    stage: "worktree-cleanup",
    timeoutMs: resolveMantisCleanupRemainingMs(deadline, "starting a Git cleanup command"),
  });
  try {
    await verifyMantisDirectoryOwnershipBeforeDeadline({
      directoryPath: params.worktreeDir,
      deadline,
      ownership: params.ownership,
      repoRoot: params.repoRoot,
    });
  } catch (ownershipError) {
    rethrowMantisCleanupDeadline(ownershipError);
    throw new Error(`Mantis worktree cleanup refused a replaced path: ${params.worktreeDir}`, {
      cause: ownershipError,
    });
  }
  try {
    // One absolute cleanup deadline covers Git plus safe recursive fallback;
    // resetting it per operation can outlive the launcher's declared grace.
    await runMantisCommand({
      command: "git",
      args: ["worktree", "remove", "--force", "--", params.worktreeDir],
      execution: createCleanupExecution(),
      lane: params.lane,
      runner: params.runner,
    });
    if (
      await verifyMantisDirectoryOwnershipBeforeDeadline({
        directoryPath: params.worktreeDir,
        deadline,
        ownership: params.ownership,
        repoRoot: params.repoRoot,
      })
    ) {
      throw new Error(
        `${params.lane} worktree-cleanup succeeded but left owned path ${params.worktreeDir}`,
      );
    }
  } catch (removeError) {
    rethrowMantisCleanupDeadline(removeError);
    let normalizedWorktreeDir: string;
    let registeredWorktreePaths: string[];
    try {
      [normalizedWorktreeDir, registeredWorktreePaths] = await Promise.all([
        normalizeWorktreePath(params.worktreeDir, params.repoRoot, deadline),
        listRegisteredWorktreePaths({
          createExecution: createCleanupExecution,
          deadline,
          lane: params.lane,
          repoRoot: params.repoRoot,
          runner: params.runner,
          worktreeDir: params.worktreeDir,
        }),
      ]);
    } catch (listError) {
      rethrowMantisCleanupDeadline(listError);
      throw createCleanupVerificationAggregate({
        errors: [removeError, listError],
        lane: params.lane,
        worktreeDir: params.worktreeDir,
      });
    }

    if (registeredWorktreePaths.includes(normalizedWorktreeDir)) {
      throw new Error(
        `${params.lane} worktree cleanup left registered path ${params.worktreeDir}`,
        { cause: removeError },
      );
    }

    let ownershipError: unknown;
    let worktreeStillOwned = false;
    try {
      worktreeStillOwned = await verifyMantisDirectoryOwnershipBeforeDeadline({
        directoryPath: params.worktreeDir,
        deadline,
        ownership: params.ownership,
        repoRoot: params.repoRoot,
      });
    } catch (error) {
      rethrowMantisCleanupDeadline(error);
      ownershipError = error;
    }
    if (ownershipError) {
      throw createCleanupVerificationAggregate({
        errors: [removeError, ownershipError],
        lane: params.lane,
        worktreeDir: params.worktreeDir,
      });
    }

    if (!worktreeStillOwned) {
      return;
    }
    try {
      await removeMantisOwnedDirectoryBeforeDeadline({
        directoryPath: params.worktreeDir,
        deadline,
        ownership: params.ownership,
        repoRoot: params.repoRoot,
        rootFactory: params.rootFactory ?? root,
      });
    } catch (removeDirectoryError) {
      rethrowMantisCleanupDeadline(removeDirectoryError);
      throw createUnregisteredDirectoryRemovalAggregate({
        errors: [removeError, removeDirectoryError],
        lane: params.lane,
        worktreeDir: params.worktreeDir,
      });
    }
  }
}
