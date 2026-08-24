// Qa Lab plugin module owns bounded Mantis worktree cleanup.
import fs from "node:fs/promises";
import path from "node:path";
import { assertNoSymlinkParents } from "openclaw/plugin-sdk/security-runtime";
import {
  runMantisCommand,
  type MantisCommandExecution,
  type MantisCommandResult,
  type MantisCommandRunner,
  type MantisCommandTimeouts,
} from "./run-command.runtime.js";
import {
  captureMantisDirectoryOwnership,
  hasSameFileIdentity,
  type MantisDirectoryOwnership,
} from "./run-directory.runtime.js";

type MantisCleanupDeadline = {
  expiresAtMs: number;
  lane: "baseline" | "candidate";
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
  lane: "baseline" | "candidate";
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

async function pathExistsBeforeDeadline(
  filePath: string,
  deadline: MantisCleanupDeadline,
): Promise<boolean> {
  try {
    await runBeforeMantisCleanupDeadline(
      deadline,
      "checking the worktree path",
      async () => await fs.lstat(filePath),
    );
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

async function verifyMantisDirectoryOwnershipBeforeDeadline(params: {
  deadline: MantisCleanupDeadline;
  ownership: MantisDirectoryOwnership;
  repoRoot: string;
  worktreeDir: string;
}): Promise<boolean> {
  await runBeforeMantisCleanupDeadline(
    params.deadline,
    "verifying worktree path containment",
    async () =>
      await assertNoSymlinkParents({
        rootDir: path.resolve(params.repoRoot),
        targetPath: path.resolve(params.worktreeDir),
      }),
  );
  let parentStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    parentStat = await runBeforeMantisCleanupDeadline(
      params.deadline,
      "reading the worktree parent identity",
      async () => await fs.lstat(path.dirname(params.worktreeDir), { bigint: true }),
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
      async () => await fs.lstat(params.worktreeDir, { bigint: true }),
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
    throw new Error(`Mantis worktree path was replaced before cleanup: ${params.worktreeDir}`);
  }
  return true;
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
    // Git gained `worktree list -z` in 2.36. Older porcelain is safe for the
    // generated path unless an ancestor contains a newline.
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

function createRetainedDirectoryError(params: {
  cause: unknown;
  lane: "baseline" | "candidate";
  worktreeDir: string;
}): Error {
  return new Error(
    `${params.lane} worktree cleanup left ${params.worktreeDir}; Mantis preserved the path because Git no longer owns it`,
    { cause: params.cause },
  );
}

export async function removeMantisWorktree(params: {
  commandTimeouts: MantisCommandTimeouts;
  lane: "baseline" | "candidate";
  ownership?: MantisDirectoryOwnership;
  repoRoot: string;
  runner: MantisCommandRunner;
  worktreeDir: string;
}): Promise<void> {
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
  const normalizedWorktreeDir = await normalizeWorktreePath(
    params.worktreeDir,
    params.repoRoot,
    deadline,
  );
  let ownership = params.ownership;

  if (!ownership) {
    const registeredWorktreePaths = await listRegisteredWorktreePaths({
      createExecution: createCleanupExecution,
      deadline,
      lane: params.lane,
      repoRoot: params.repoRoot,
      runner: params.runner,
      worktreeDir: params.worktreeDir,
    });
    if (!registeredWorktreePaths.includes(normalizedWorktreeDir)) {
      if (await pathExistsBeforeDeadline(params.worktreeDir, deadline)) {
        throw createRetainedDirectoryError({
          cause: new Error("the failed worktree add did not yield an ownership receipt"),
          lane: params.lane,
          worktreeDir: params.worktreeDir,
        });
      }
      return;
    }
    ownership = await runBeforeMantisCleanupDeadline(
      deadline,
      "capturing the registered worktree identity",
      async () =>
        await captureMantisDirectoryOwnership({
          directoryPath: params.worktreeDir,
          repoRoot: params.repoRoot,
        }),
    );
  }

  try {
    const present = await verifyMantisDirectoryOwnershipBeforeDeadline({
      deadline,
      ownership,
      repoRoot: params.repoRoot,
      worktreeDir: params.worktreeDir,
    });
    if (!present) {
      throw new Error(`Mantis registered worktree path disappeared: ${params.worktreeDir}`);
    }
  } catch (ownershipError) {
    rethrowMantisCleanupDeadline(ownershipError);
    throw new Error(`Mantis worktree cleanup refused a replaced path: ${params.worktreeDir}`, {
      cause: ownershipError,
    });
  }

  let removeError: unknown;
  try {
    // Git owns the registration and validates its .git link before deleting.
    // Mantis never recursively removes a path after Git gives up ownership.
    await runMantisCommand({
      command: "git",
      args: ["worktree", "remove", "--force", "--", params.worktreeDir],
      execution: createCleanupExecution(),
      lane: params.lane,
      runner: params.runner,
    });
  } catch (error) {
    rethrowMantisCleanupDeadline(error);
    removeError = error;
  }

  let registeredWorktreePaths: string[];
  try {
    registeredWorktreePaths = await listRegisteredWorktreePaths({
      createExecution: createCleanupExecution,
      deadline,
      lane: params.lane,
      repoRoot: params.repoRoot,
      runner: params.runner,
      worktreeDir: params.worktreeDir,
    });
  } catch (listError) {
    rethrowMantisCleanupDeadline(listError);
    throw createCleanupVerificationAggregate({
      errors: [removeError ?? new Error("Git worktree removal completed"), listError],
      lane: params.lane,
      worktreeDir: params.worktreeDir,
    });
  }
  if (registeredWorktreePaths.includes(normalizedWorktreeDir)) {
    throw new Error(`${params.lane} worktree cleanup left registered path ${params.worktreeDir}`, {
      cause: removeError,
    });
  }

  if (await pathExistsBeforeDeadline(params.worktreeDir, deadline)) {
    throw createRetainedDirectoryError({
      cause: removeError ?? new Error("Git reported success but left the directory"),
      lane: params.lane,
      worktreeDir: params.worktreeDir,
    });
  }
}
