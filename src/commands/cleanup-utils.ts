// Shared destructive-cleanup planning and guarded removal helpers.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { AgentsDeleteResult } from "../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace-default.js";
import {
  prepareLegacyWorkspaceStateReset,
  removeLegacyWorkspaceStateForReset,
} from "../agents/workspace-legacy-state.js";
import {
  deleteWorkspaceState,
  prepareWorkspaceStateDeletion,
} from "../agents/workspace-state-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage, isMissingPathError } from "../infra/errors.js";
import { movePathToTrash } from "../infra/fs-safe.js";
import { acquireGatewayLock, GatewayLockError } from "../infra/gateway-lock.js";
import { hasNodeErrorCode, isPathInside } from "../infra/path-guards.js";
import { acquireStateDatabaseCoordinator } from "../infra/state-database-coordinator.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveHomeDir, shortenHomeInString, shortenHomePath } from "../utils.js";

type RemovalResult = {
  ok: boolean;
};

type AgentDeleteRemovedPath = NonNullable<AgentsDeleteResult["removed"]>[number];
type AgentDeleteFailedPath = NonNullable<AgentsDeleteResult["failed"]>[number];
type MoveToTrashResult = { removed: AgentDeleteRemovedPath } | { failed: AgentDeleteFailedPath };

type CleanupResolvedPaths = {
  stateDir: string;
  configPath: string;
  oauthDir: string;
  configInsideState: boolean;
  oauthInsideState: boolean;
};

type RemovalOptions = {
  dryRun?: boolean;
  label?: string;
};

type StateRemovalOptions = {
  dryRun?: boolean;
  preservePaths?: readonly string[];
};

const STATE_CLEANUP_LOCK_TIMEOUT_MS = 250;
const STATE_CLEANUP_LOCK_POLL_INTERVAL_MS = 25;

function trashFailure(pathname: string, error: unknown, runtime: RuntimeEnv): MoveToTrashResult {
  runtime.log(`Failed to move to Trash (manual delete): ${shortenHomePath(pathname)}`);
  return { failed: { path: pathname, reason: formatErrorMessage(error) } };
}

export async function moveToTrashResult(
  pathname: string,
  runtime: RuntimeEnv,
  assertCurrent?: () => void,
): Promise<MoveToTrashResult> {
  if (!pathname) {
    return { failed: { path: pathname, reason: "path is empty" } };
  }
  try {
    await fs.lstat(pathname);
  } catch (error) {
    return isMissingPathError(error)
      ? { removed: { path: pathname, method: "missing" } }
      : trashFailure(pathname, error, runtime);
  }
  try {
    const targetPath = path.resolve(pathname);
    const sourcePath = await resolveMoveToTrashSourcePath(targetPath);
    const allowedRoots = await resolveMoveToTrashAllowedRoots(sourcePath);
    // Preparation can outlive its owner; revalidate immediately before Trash dispatch.
    assertCurrent?.();
    await movePathToTrash(sourcePath, { allowedRoots });
    runtime.log(`Moved to Trash: ${shortenHomePath(pathname)}`);
    return { removed: { path: pathname, method: "trash" } };
  } catch (error) {
    return trashFailure(pathname, error, runtime);
  }
}

/** Moves a path to Trash when it exists, logging a manual-delete fallback on failure. */
export async function moveToTrash(
  pathname: string,
  runtime: RuntimeEnv,
  assertCurrent?: () => void,
): Promise<boolean> {
  return "removed" in (await moveToTrashResult(pathname, runtime, assertCurrent));
}

async function resolveMoveToTrashSourcePath(targetPath: string): Promise<string> {
  return path.join(await fs.realpath(path.dirname(targetPath)), path.basename(targetPath));
}

async function resolveMoveToTrashAllowedRoots(targetPath: string): Promise<string[]> {
  const allowedRoots = [path.dirname(targetPath)];
  const stat = await fs.lstat(targetPath);
  if (stat.isSymbolicLink()) {
    try {
      // fs-safe resolves valid symlinks before allow-root checks; include the
      // resolved parent so deleting a configured symlink moves the link itself.
      allowedRoots.push(path.dirname(await fs.realpath(targetPath)));
    } catch {
      // Broken symlinks are handled lexically by fs-safe.
    }
  }
  return uniqueStrings(allowedRoots);
}

function collectWorkspaceDirs(cfg: OpenClawConfig | undefined): string[] {
  const dirs = new Set<string>();
  if (!cfg) {
    dirs.add(resolveDefaultAgentWorkspaceDir());
    return [...dirs];
  }
  for (const agentId of listAgentIds(cfg)) {
    dirs.add(resolveAgentWorkspaceDir(cfg, agentId));
  }
  return [...dirs];
}

/** Determine which config, credential, and workspace paths cleanup should consider. */
export function buildCleanupPlan(params: {
  cfg: OpenClawConfig | undefined;
  stateDir: string;
  configPath: string;
  oauthDir: string;
}): {
  configInsideState: boolean;
  oauthInsideState: boolean;
  workspaceDirs: string[];
} {
  return {
    configInsideState: isPathWithin(params.configPath, params.stateDir),
    oauthInsideState: isPathWithin(params.oauthDir, params.stateDir),
    workspaceDirs: collectWorkspaceDirs(params.cfg),
  };
}

/** Return true when `child` resolves inside `parent`. */
export function isPathWithin(child: string, parent: string): boolean {
  return isPathInside(parent, child);
}

function isUnsafeRemovalTarget(target: string): boolean {
  if (!target.trim()) {
    return true;
  }
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  if (resolved === root) {
    return true;
  }
  const home = resolveHomeDir();
  if (home && resolved === path.resolve(home)) {
    return true;
  }
  if (isPathWithin(path.resolve(process.cwd()), resolved)) {
    return true;
  }
  return false;
}

/** Remove one path after rejecting empty/root/home targets and honoring dry-run mode. */
export async function removePath(
  target: string,
  runtime: RuntimeEnv,
  opts?: RemovalOptions,
): Promise<RemovalResult> {
  if (!target?.trim()) {
    return { ok: false };
  }
  const resolved = path.resolve(target);
  const label = opts?.label ?? resolved;
  const displayLabel = shortenHomeInString(label);
  if (isUnsafeRemovalTarget(resolved)) {
    runtime.error(`Refusing to remove unsafe path: ${displayLabel}`);
    return { ok: false };
  }
  if (opts?.dryRun) {
    runtime.log(`[dry-run] remove ${displayLabel}`);
    return { ok: true };
  }
  try {
    await fs.rm(resolved, { recursive: true, force: true });
    runtime.log(`Removed ${displayLabel}`);
    return { ok: true };
  } catch (err) {
    runtime.error(`Failed to remove ${displayLabel}: ${String(err)}`);
    return { ok: false };
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function existingPaths(paths: readonly string[]): Promise<string[]> {
  const existing: string[] = [];
  for (const target of paths) {
    if (!target?.trim()) {
      continue;
    }
    const resolved = path.resolve(target);
    try {
      await fs.lstat(resolved);
      existing.push(resolved);
    } catch {
      // Missing workspaces do not need preservation during destructive cleanup.
    }
  }
  return existing;
}

// Service-manager status is advisory; the state lock also covers externally supervised Gateways.
async function acquireStateCleanupOwnership(cleanup: CleanupResolvedPaths) {
  const env = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: cleanup.configPath,
    OPENCLAW_STATE_DIR: cleanup.stateDir,
  };
  let lock: Awaited<ReturnType<typeof acquireGatewayLock>>;
  try {
    lock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: STATE_CLEANUP_LOCK_POLL_INTERVAL_MS,
      // Shipped readers validate this role as any live OpenClaw process. A new
      // wire role would let mixed-version Gateways misclassify cleanup as stale.
      role: "agent-embedded",
      timeoutMs: STATE_CLEANUP_LOCK_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof GatewayLockError) {
      throw new Error(
        "Cannot remove OpenClaw state while the Gateway or another state maintenance command owns this state directory. Stop the Gateway and retry.",
        { cause: error },
      );
    }
    throw error;
  }
  if (!lock) {
    throw new Error("Cannot remove OpenClaw state without exclusive state ownership.");
  }
  return lock;
}

function shouldPreservePath(target: string, preservePaths: readonly string[]): boolean {
  return preservePaths.some((preservePath) => isPathWithin(target, preservePath));
}

function pathContainsPreservedPath(target: string, preservePaths: readonly string[]): boolean {
  return preservePaths.some((preservePath) => isPathWithin(preservePath, target));
}

async function removePathPreserving(
  target: string,
  preservePaths: readonly string[],
  runtime: RuntimeEnv,
  opts?: RemovalOptions,
): Promise<RemovalResult> {
  if (!target?.trim()) {
    return { ok: false };
  }
  const resolved = path.resolve(target);
  const label = opts?.label ?? resolved;
  const displayLabel = shortenHomeInString(label);
  if (isUnsafeRemovalTarget(resolved)) {
    runtime.error(`Refusing to remove unsafe path: ${displayLabel}`);
    return { ok: false };
  }
  if (shouldPreservePath(resolved, preservePaths)) {
    return { ok: true };
  }
  if (!pathContainsPreservedPath(resolved, preservePaths)) {
    return removePath(resolved, runtime, opts);
  }
  if (opts?.dryRun) {
    const preserved = preservePaths
      .filter((preservePath) => isPathWithin(preservePath, resolved))
      .map((preservePath) => shortenHomeInString(preservePath))
      .join(", ");
    runtime.log(`[dry-run] remove ${displayLabel} preserving ${preserved}`);
    return { ok: true };
  }
  try {
    const stat = await fs.lstat(resolved);
    if (!stat.isDirectory()) {
      return removePath(resolved, runtime, opts);
    }
    const entries = await fs.readdir(resolved);
    for (const entry of entries) {
      const result = await removePathPreserving(path.join(resolved, entry), preservePaths, runtime);
      if (!result.ok) {
        return result;
      }
    }
    runtime.log(`Removed contents of ${displayLabel}`);
    return { ok: true };
  } catch (err) {
    runtime.error(`Failed to remove ${displayLabel}: ${String(err)}`);
    return { ok: false };
  }
}

async function detachStateLockDirectory(
  lockDir: string,
  stateDir: string,
  runtime: RuntimeEnv,
): Promise<string> {
  const tombstone = path.join(
    path.dirname(stateDir),
    `.${path.basename(stateDir)}-locks.cleanup-${randomUUID()}`,
  );
  try {
    await fs.rename(lockDir, tombstone);
    return tombstone;
  } catch (error) {
    const message = `Failed to finalize OpenClaw state cleanup because the lock directory changed: ${String(error)}`;
    runtime.error(message);
    throw new Error(message, { cause: error });
  }
}

async function removeStateDirectoryAlias(
  requestedStateDir: string,
  stateDir: string,
): Promise<void> {
  if (requestedStateDir === stateDir) {
    return;
  }
  try {
    if ((await fs.lstat(requestedStateDir)).isSymbolicLink()) {
      await fs.unlink(requestedStateDir);
    }
  } catch (error) {
    if (!hasNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function removeEmptyStateAncestors(startDir: string, stateDir: string): Promise<boolean> {
  for (let current = startDir; isPathWithin(current, stateDir); current = path.dirname(current)) {
    try {
      await fs.rmdir(current);
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT")) {
        continue;
      }
      if (hasNodeErrorCode(error, "ENOTEMPTY") || hasNodeErrorCode(error, "EEXIST")) {
        return false;
      }
      throw error;
    }
    if (current === stateDir) {
      return true;
    }
  }
  return false;
}

async function removeLinkedCleanupPaths(
  cleanup: CleanupResolvedPaths,
  runtime: RuntimeEnv,
): Promise<void> {
  const externalPaths = [
    cleanup.configInsideState ? undefined : cleanup.configPath,
    cleanup.oauthInsideState ? undefined : cleanup.oauthDir,
  ].filter((target): target is string => target !== undefined);
  for (const target of externalPaths) {
    if (!(await removePath(target, runtime, { label: target })).ok) {
      throw new Error(`Failed to remove linked cleanup path: ${shortenHomeInString(target)}`);
    }
  }
}

/** Remove state plus config/OAuth paths, preserving selected paths nested inside state. */
export async function removeStateAndLinkedPaths(
  cleanup: CleanupResolvedPaths,
  runtime: RuntimeEnv,
  opts?: StateRemovalOptions,
): Promise<boolean> {
  const requestedStateDir = path.resolve(cleanup.stateDir);
  const requestedPreservePaths = opts?.dryRun
    ? (opts.preservePaths ?? []).map((target) => path.resolve(target))
    : await existingPaths(opts?.preservePaths ?? []);
  if (opts?.dryRun) {
    const preservePaths = requestedPreservePaths.filter((target) =>
      isPathWithin(target, requestedStateDir),
    );
    const stateRemoval =
      preservePaths.length > 0
        ? await removePathPreserving(requestedStateDir, preservePaths, runtime, {
            dryRun: true,
            label: cleanup.stateDir,
          })
        : await removePath(cleanup.stateDir, runtime, {
            dryRun: true,
            label: cleanup.stateDir,
          });
    const configRemoval = cleanup.configInsideState
      ? { ok: true }
      : await removePath(cleanup.configPath, runtime, { dryRun: true, label: cleanup.configPath });
    const oauthRemoval = cleanup.oauthInsideState
      ? { ok: true }
      : await removePath(cleanup.oauthDir, runtime, { dryRun: true, label: cleanup.oauthDir });
    return stateRemoval.ok && configRemoval.ok && oauthRemoval.ok;
  }
  if (isUnsafeRemovalTarget(requestedStateDir)) {
    runtime.error(`Refusing to remove unsafe path: ${shortenHomeInString(cleanup.stateDir)}`);
    return false;
  }

  const lock = await acquireStateCleanupOwnership(cleanup);
  let lockHeld = true;
  let stateCoordinator: ReturnType<typeof acquireStateDatabaseCoordinator> | undefined;
  const releaseLock = async () => {
    if (!lockHeld) {
      return;
    }
    lockHeld = false;
    await lock.release();
  };
  const releaseStateCoordinator = () => {
    const held = stateCoordinator;
    stateCoordinator = undefined;
    held?.release();
  };
  try {
    const stateDir = lock.stateDir;
    if (isUnsafeRemovalTarget(stateDir)) {
      throw new Error(`Refusing to remove unsafe path: ${shortenHomeInString(stateDir)}`);
    }
    const lockDir = path.dirname(lock.stateLockPath);
    if (!isPathWithin(lockDir, stateDir)) {
      throw new Error("Cannot remove OpenClaw state because its active lock is outside state.");
    }
    const databasePath = resolveOpenClawStateSqlitePath({
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
    });
    stateCoordinator = acquireStateDatabaseCoordinator({
      databasePath,
      busyTimeoutMs: 0,
    });
    const preservePaths = requestedPreservePaths
      .map((target) =>
        isPathWithin(target, requestedStateDir)
          ? path.join(stateDir, path.relative(requestedStateDir, target))
          : target,
      )
      .filter((target) => isPathWithin(target, stateDir));
    const overlappingPreservePath = preservePaths.find(
      (target) => isPathWithin(target, lockDir) || isPathWithin(lockDir, target),
    );
    if (overlappingPreservePath) {
      throw new Error(
        `Cannot remove OpenClaw state while preserving ${shortenHomeInString(overlappingPreservePath)} because it overlaps the active state lock. Move the workspace outside the lock directory and retry.`,
      );
    }
    const stateRemoval = await removePathPreserving(
      stateDir,
      [...preservePaths, lockDir],
      runtime,
      { label: cleanup.stateDir },
    );
    if (!stateRemoval.ok) {
      throw new Error("Failed to remove non-preserved OpenClaw state while ownership was held.");
    }

    // Drop only the removable in-tree handles; external Gateway presence stays held
    // through finalization so a new owner cannot start inside the cleanup window.
    await lock.releaseInTree();
    const lockTombstone = await detachStateLockDirectory(lockDir, stateDir, runtime);
    if (!(await removePath(lockTombstone, runtime, { label: "detached state locks" })).ok) {
      throw new Error(`Failed to remove detached state locks at ${lockTombstone}.`);
    }

    const stateDirRemoved = await removeEmptyStateAncestors(path.dirname(lockDir), stateDir);
    const newStateOperationStarted =
      (await pathExists(lockDir)) || (preservePaths.length === 0 && !stateDirRemoved);
    if (newStateOperationStarted) {
      throw new Error(
        "OpenClaw state cleanup was interrupted by a new state operation. Stop other OpenClaw commands and retry.",
      );
    }
    if (stateDirRemoved) {
      await removeStateDirectoryAlias(requestedStateDir, stateDir);
    }
    await removeLinkedCleanupPaths(cleanup, runtime);
    return true;
  } finally {
    try {
      releaseStateCoordinator();
    } finally {
      await releaseLock();
    }
  }
}

/** Remove all workspace directories selected by the cleanup plan. */
export async function removeWorkspaceDirs(
  workspaceDirs: readonly string[],
  runtime: RuntimeEnv,
  opts?: {
    dryRun?: boolean;
    preserveWorkspace?: boolean;
    removeStateRows?: boolean;
    removeWorkspace?: (workspace: string) => Promise<boolean>;
  },
): Promise<string[]> {
  const failures = new Set<string>();
  const attempt = async <T>(label: string, action: () => T | Promise<T>) => {
    try {
      return await action();
    } catch (error) {
      failures.add(label);
      runtime.error?.(`Failed to clean up ${shortenHomeInString(label)}: ${String(error)}`);
      return undefined;
    }
  };
  for (const workspace of workspaceDirs) {
    const legacyLabel = `${workspace} (retired workspace state)`;
    const stateLabel = `${workspace} (workspace state)`;
    const legacyPlan = await attempt(legacyLabel, () =>
      prepareLegacyWorkspaceStateReset(workspace),
    );
    const statePlan = opts?.removeStateRows
      ? await attempt(stateLabel, () => prepareWorkspaceStateDeletion(workspace))
      : undefined;
    const result = opts?.preserveWorkspace
      ? { ok: true }
      : opts?.removeWorkspace
        ? { ok: (await attempt(workspace, () => opts.removeWorkspace!(workspace))) === true }
        : await removePath(workspace, runtime, { dryRun: opts?.dryRun, label: workspace });
    if (!result.ok) {
      failures.add(workspace);
      continue;
    }
    if (legacyPlan) {
      const legacyCleanup = await attempt(legacyLabel, () =>
        removeLegacyWorkspaceStateForReset(legacyPlan, opts?.dryRun ? { dryRun: true } : undefined),
      );
      if (legacyCleanup) {
        if (opts?.dryRun) {
          for (const removedPath of legacyCleanup.removedPaths) {
            runtime.log(`[dry-run] remove ${shortenHomeInString(removedPath)}`);
          }
        }
        for (const warning of legacyCleanup.warnings) {
          (opts?.removeWorkspace ? runtime.log : runtime.error)(warning);
          failures.add(warning);
        }
      }
    }
    if (!opts?.dryRun && statePlan) {
      await attempt(stateLabel, () => {
        deleteWorkspaceState(statePlan);
      });
    }
  }
  return [...failures];
}

/** List per-agent session directories beneath a state directory. */
export async function listAgentSessionDirs(stateDir: string): Promise<string[]> {
  const root = path.join(stateDir, "agents");
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, "sessions"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
