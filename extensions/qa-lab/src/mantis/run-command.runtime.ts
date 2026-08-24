// Qa Lab plugin module implements Mantis command-stage behavior.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  addTimerTimeoutGraceMs,
  resolvePositiveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { assertNoSymlinkParents, root } from "openclaw/plugin-sdk/security-runtime";
import { readQaScenarioById } from "../scenario-catalog.js";
import { MANTIS_WORKTREE_CLEANUP_TIMEOUT_MS } from "./run-command.constants.js";

type MantisCommandStage = "worktree-add" | "install" | "build" | "qa" | "worktree-cleanup";
export type MantisCommandExecution = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  stage: MantisCommandStage;
  timeoutMs: number;
};
type MantisCommandResult = Awaited<ReturnType<typeof runCommandWithTimeout>>;
export type MantisWorktreeOwnership = {
  parentDevice: number;
  parentInode: number;
  targetDevice: number;
  targetInode: number;
};
export type MantisCommandRunner = (
  command: string,
  args: readonly string[],
  execution: MantisCommandExecution,
) => Promise<MantisCommandResult>;
export type MantisCommandTimeoutOverrides = Partial<Record<MantisCommandStage, number>>;
export type MantisCommandTimeouts = Record<MantisCommandStage, number>;

const DEFAULT_WORKTREE_ADD_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_BUILD_TIMEOUT_MS = 30 * 60_000;
const QA_COMMAND_TIMEOUT_GRACE_MS = 5 * 60_000;

type MantisCleanupDeadline = {
  expiresAtMs: number;
  lane: "baseline" | "candidate";
  timeoutMs: number;
};

class MantisCleanupDeadlineError extends Error {
  constructor(deadline: MantisCleanupDeadline, operation: string) {
    super(
      `${deadline.lane} worktree cleanup exceeded its total ${deadline.timeoutMs}ms deadline while ${operation}`,
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

function resolveQaCommandTimeoutMs(scenarioId: string): number {
  const scenario = readQaScenarioById(scenarioId);
  const execution = scenario.execution;
  if (execution.kind !== "flow" || !execution.flow) {
    throw new Error(`Mantis scenario ${scenarioId} must be a flow QA scenario.`);
  }
  const timeoutMs = execution.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Mantis scenario ${scenarioId} must define a positive execution.timeoutMs.`);
  }
  const attemptCount = execution.retryCount === 0 ? 1 : 2;
  const attemptedTimeoutMs = timeoutMs * attemptCount;
  const timeoutWithGraceMs = addTimerTimeoutGraceMs(
    attemptedTimeoutMs,
    QA_COMMAND_TIMEOUT_GRACE_MS,
  );
  return resolvePositiveTimerTimeoutMs(timeoutWithGraceMs, timeoutMs);
}

export function resolveMantisCommandTimeouts(
  scenarioId: string,
  overrides: MantisCommandTimeoutOverrides | undefined,
): MantisCommandTimeouts {
  const defaults: MantisCommandTimeouts = {
    "worktree-add": DEFAULT_WORKTREE_ADD_TIMEOUT_MS,
    install: DEFAULT_INSTALL_TIMEOUT_MS,
    build: DEFAULT_BUILD_TIMEOUT_MS,
    qa: resolveQaCommandTimeoutMs(scenarioId),
    "worktree-cleanup": MANTIS_WORKTREE_CLEANUP_TIMEOUT_MS,
  };
  return {
    "worktree-add": resolvePositiveTimerTimeoutMs(
      overrides?.["worktree-add"],
      defaults["worktree-add"],
    ),
    install: resolvePositiveTimerTimeoutMs(overrides?.install, defaults.install),
    build: resolvePositiveTimerTimeoutMs(overrides?.build, defaults.build),
    qa: resolvePositiveTimerTimeoutMs(overrides?.qa, defaults.qa),
    "worktree-cleanup": resolvePositiveTimerTimeoutMs(
      overrides?.["worktree-cleanup"],
      defaults["worktree-cleanup"],
    ),
  };
}

function isWorktreeListCommand(command: string, args: readonly string[]): boolean {
  return (
    command === "git" &&
    (args.length === 3 || args.length === 4) &&
    args[0] === "worktree" &&
    args[1] === "list" &&
    args[2] === "--porcelain" &&
    (args.length === 3 || args[3] === "-z")
  );
}

export async function defaultMantisCommandRunner(
  command: string,
  args: readonly string[],
  execution: MantisCommandExecution,
): Promise<MantisCommandResult> {
  const capturesWorktreeList = isWorktreeListCommand(command, args);
  return await runCommandWithTimeout([command, ...args], {
    cwd: execution.cwd,
    env: execution.env,
    killProcessTree: true,
    outputCapture: capturesWorktreeList ? { stdout: "head", stderr: "tail" } : "discard",
    signal: execution.signal,
    timeoutMs: execution.timeoutMs,
    ...(capturesWorktreeList
      ? {}
      : {
          onOutputChunk(chunk, stream) {
            (stream === "stdout" ? process.stdout : process.stderr).write(chunk);
          },
        }),
  });
}

export function assertMantisCommandNotAborted(params: {
  args: readonly string[];
  command: string;
  execution: MantisCommandExecution;
  lane: "baseline" | "candidate";
}): void {
  if (!params.execution.signal?.aborted) {
    return;
  }
  const commandLabel = [params.command, ...params.args].join(" ");
  throw new Error(`${params.lane} ${params.execution.stage} aborted: ${commandLabel}`, {
    cause: params.execution.signal.reason,
  });
}

export async function runMantisCommand(params: {
  args: readonly string[];
  command: string;
  execution: MantisCommandExecution;
  lane: "baseline" | "candidate";
  runner: MantisCommandRunner;
}): Promise<MantisCommandResult> {
  assertMantisCommandNotAborted(params);
  const label = [params.command, ...params.args].join(" ");
  let result: MantisCommandResult;
  try {
    result = await params.runner(params.command, params.args, params.execution);
  } catch (error) {
    if (params.execution.signal?.aborted) {
      throw new Error(`${params.lane} ${params.execution.stage} aborted: ${label}`, {
        cause: params.execution.signal.reason,
      });
    }
    throw new Error(
      `${params.lane} ${params.execution.stage} failed to run ${label}: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
  if (result.termination === "timeout") {
    throw new Error(
      `${params.lane} ${params.execution.stage} timed out after ${params.execution.timeoutMs}ms: ${label}`,
    );
  }
  if (result.termination === "signal" && params.execution.signal?.aborted) {
    throw new Error(`${params.lane} ${params.execution.stage} aborted: ${label}`, {
      cause: params.execution.signal.reason,
    });
  }
  if (result.code === 0) {
    return result;
  }
  const detail = result.signal
    ? `signal ${result.signal}`
    : `exit code ${result.code ?? "unknown"}`;
  throw new Error(`${params.lane} ${params.execution.stage} failed with ${detail}: ${label}`);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isPathWithinOrEqual(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hasSameFileIdentity(
  first: { dev: number; ino: number },
  second: { dev: number; ino: number },
): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

export async function createMantisWorktreeDirectory(params: {
  repoRoot: string;
  worktreeDir: string;
}): Promise<MantisWorktreeOwnership> {
  const repoRoot = path.resolve(params.repoRoot);
  const worktreeDir = path.resolve(params.worktreeDir);
  const parentDir = path.dirname(worktreeDir);

  await assertNoSymlinkParents({ rootDir: repoRoot, targetPath: worktreeDir });
  const parentStat = await fs.lstat(parentDir);
  await fs.mkdir(worktreeDir);
  const targetStat = await fs.lstat(worktreeDir);
  return {
    parentDevice: parentStat.dev,
    parentInode: parentStat.ino,
    targetDevice: targetStat.dev,
    targetInode: targetStat.ino,
  };
}

async function verifyMantisWorktreeOwnership(params: {
  deadline: MantisCleanupDeadline;
  ownership: MantisWorktreeOwnership;
  repoRoot: string;
  worktreeDir: string;
}): Promise<boolean> {
  // Recheck the owned path immediately before recursive removal; otherwise a
  // replaced parent or target could redirect cleanup outside the Mantis output.
  await runBeforeMantisCleanupDeadline(
    params.deadline,
    "verifying worktree path ownership",
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
      async () => await fs.lstat(path.dirname(params.worktreeDir)),
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
      async () => await fs.lstat(params.worktreeDir),
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

async function removeMantisWorktreeDirectory(params: {
  deadline: MantisCleanupDeadline;
  ownership: MantisWorktreeOwnership;
  repoRoot: string;
  worktreeDir: string;
}): Promise<void> {
  // Recursive fallback removal stays anchored to the canonical repo root; a raw
  // fs.rm path could follow a swapped parent into an unrelated directory.
  const canonicalRepoRoot = await runBeforeMantisCleanupDeadline(
    params.deadline,
    "resolving the repository root",
    async () => await fs.realpath(path.resolve(params.repoRoot)),
  );
  const worktreeDir = path.resolve(params.worktreeDir);
  if (!(await verifyMantisWorktreeOwnership(params))) {
    return;
  }
  const canonicalWorktreeDir = await runBeforeMantisCleanupDeadline(
    params.deadline,
    "resolving the unregistered worktree",
    async () => await fs.realpath(worktreeDir),
  );
  if (
    canonicalWorktreeDir === canonicalRepoRoot ||
    !isPathWithinOrEqual(canonicalRepoRoot, canonicalWorktreeDir)
  ) {
    throw new Error(`Mantis worktree path escaped the repository: ${params.worktreeDir}`);
  }

  const relativeWorktreeDir = path
    .relative(canonicalRepoRoot, canonicalWorktreeDir)
    .split(path.sep)
    .join(path.posix.sep);
  const repoRootHandle = await runBeforeMantisCleanupDeadline(
    params.deadline,
    "opening the safe repository root",
    async () => await root(canonicalRepoRoot),
  );
  const quarantineRelativePath = path.posix.join(
    path.posix.dirname(relativeWorktreeDir),
    `.mantis-cleanup-${process.pid}-${randomUUID()}`,
  );
  // fs-safe's Node fallback requires explicit overwrite for directory moves;
  // the UUID quarantine path is fresh and keeps recursive cleanup root-bound.
  await runBeforeMantisCleanupDeadline(params.deadline, "quarantining the worktree", async () =>
    repoRootHandle.move(relativeWorktreeDir, quarantineRelativePath, { overwrite: true }),
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
    throw new Error(`Mantis worktree target changed while quarantining ${params.worktreeDir}`);
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
        await runBeforeMantisCleanupDeadline(
          params.deadline,
          "removing a quarantined worktree entry",
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
    await runBeforeMantisCleanupDeadline(
      params.deadline,
      "removing a quarantined worktree directory",
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

export async function removeMantisWorktree(params: {
  commandTimeouts: MantisCommandTimeouts;
  lane: "baseline" | "candidate";
  repoRoot: string;
  runner: MantisCommandRunner;
  worktreeDir: string;
  ownership: MantisWorktreeOwnership;
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
    await verifyMantisWorktreeOwnership({
      deadline,
      ownership: params.ownership,
      repoRoot: params.repoRoot,
      worktreeDir: params.worktreeDir,
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
      await verifyMantisWorktreeOwnership({
        deadline,
        ownership: params.ownership,
        repoRoot: params.repoRoot,
        worktreeDir: params.worktreeDir,
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
      worktreeStillOwned = await verifyMantisWorktreeOwnership({
        deadline,
        ownership: params.ownership,
        repoRoot: params.repoRoot,
        worktreeDir: params.worktreeDir,
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
      await removeMantisWorktreeDirectory({
        deadline,
        ownership: params.ownership,
        repoRoot: params.repoRoot,
        worktreeDir: params.worktreeDir,
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
