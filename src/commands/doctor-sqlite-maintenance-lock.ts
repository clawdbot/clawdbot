/** Serializes offline SQLite maintenance against the Gateway state owner. */
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolvePathViaExistingAncestorSync, resolveRootPathSync } from "../infra/boundary-path.js";
import {
  acquireGatewayLock,
  GatewayLockError,
  type GatewayLockOptions,
} from "../infra/gateway-lock.js";
import { isPathInside } from "../infra/path-guards.js";
import type { DoctorSessionSqliteMode } from "./doctor-session-sqlite-types.js";

const MAINTENANCE_LOCK_TIMEOUT_MS = 250;
const MAINTENANCE_LOCK_POLL_INTERVAL_MS = 25;

type MaintenanceLockOptions = Pick<
  GatewayLockOptions,
  | "lockDir"
  | "now"
  | "platform"
  | "pollIntervalMs"
  | "readProcessCmdline"
  | "readProcessStartTime"
  | "sleep"
  | "staleMs"
  | "timeoutMs"
>;

type DoctorSqliteMaintenanceLockDeps = {
  acquireLock?: typeof acquireGatewayLock;
  lockOptions?: MaintenanceLockOptions;
};

export type DoctorSqliteMaintenanceAuthority = {
  assertCurrent(): void;
};

export class DoctorSqliteMaintenanceLockUnavailableError extends Error {
  constructor(
    operation: string,
    public override readonly cause: GatewayLockError,
  ) {
    super(
      `Cannot run ${operation} while the Gateway or another SQLite maintenance command owns this OpenClaw state directory. Stop the Gateway and retry.`,
    );
    this.name = "DoctorSqliteMaintenanceLockUnavailableError";
  }
}

async function assertMaintenancePathsOwnedByStateDir(
  env: NodeJS.ProcessEnv,
  operation: string,
  protectedPaths: readonly string[],
  reconcileHardlink?: (filePath: string) => Promise<void>,
): Promise<void> {
  if (protectedPaths.length === 0) {
    return;
  }
  const stateDir = path.resolve(resolveStateDir(env));
  const stateCanonicalDir = resolvePathViaExistingAncestorSync(stateDir);
  for (const protectedPath of protectedPaths) {
    const absolutePath = path.resolve(protectedPath);
    try {
      if (!isPathInside(stateDir, absolutePath) && !isPathInside(stateCanonicalDir, absolutePath)) {
        throw new Error("path is not lexically owned by the active state directory");
      }
      resolveRootPathSync({
        absolutePath,
        boundaryLabel: "OpenClaw state directory",
        rootCanonicalPath: stateCanonicalDir,
        rootPath: stateDir,
      });
    } catch (error) {
      throw new Error(
        `Cannot run ${operation} for a path outside the active OpenClaw state directory: ${protectedPath}. Set OPENCLAW_STATE_DIR to the owning state directory and retry.`,
        { cause: error },
      );
    }
  }
  if (reconcileHardlink) {
    for (const protectedPath of new Set(
      protectedPaths.map((candidate) => path.resolve(candidate)),
    )) {
      const stat = inspectMaintenancePath(operation, protectedPath, [stateDir]);
      if (stat?.isFile() && stat.nlink > 1) {
        await reconcileHardlink(protectedPath);
      }
    }
  }
  // Reconciliation can await durable publication. Recheck every path afterward under the
  // same state lock; repairing a recorded alias never permits maintenance of other aliases.
  assertDoctorSqliteMaintenancePathsNotAliased(operation, protectedPaths, [stateDir]);
}

/** Reject file aliases that destructive SQLite maintenance would mutate in place. */
export function assertDoctorSqliteMaintenancePathsNotAliased(
  operation: string,
  protectedPaths: readonly string[],
  ownershipRoots: readonly string[] = [],
): void {
  const resolvedRoots = ownershipRoots.map((candidate) => path.resolve(candidate));
  for (const protectedPath of new Set(protectedPaths.map((candidate) => path.resolve(candidate)))) {
    const stat = inspectMaintenancePath(operation, protectedPath, resolvedRoots);
    if (stat?.isFile() && stat.nlink > 1) {
      throw new Error(
        `Cannot run ${operation} for a hard-linked path: ${protectedPath}. Remove the additional hard link and retry.`,
      );
    }
  }
}

function inspectMaintenancePath(
  operation: string,
  protectedPath: string,
  ownershipRoots: readonly string[],
): fs.Stats | undefined {
  assertPathComponentsNotSymbolicLinks(operation, protectedPath, ownershipRoots);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(protectedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(
      `Cannot run ${operation} for a symbolic-link path: ${protectedPath}. Replace the symbolic link with an owned regular file and retry.`,
    );
  }
  return stat;
}

function assertPathComponentsNotSymbolicLinks(
  operation: string,
  protectedPath: string,
  ownershipRoots: readonly string[],
): void {
  const rootPath = ownershipRoots.find((candidate) => isPathInside(candidate, protectedPath));
  if (!rootPath) {
    return;
  }
  const relativePath = path.relative(rootPath, protectedPath);
  let currentPath = rootPath;
  for (const segment of relativePath.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(currentPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Cannot run ${operation} through a symbolic-link path component: ${currentPath}. Replace the symbolic link with an owned directory or regular file and retry.`,
      );
    }
  }
}

export function isDestructiveDoctorSessionSqliteMode(mode: DoctorSessionSqliteMode): boolean {
  return mode === "import" || mode === "compact" || mode === "restore" || mode === "recover";
}

/** Run one destructive doctor operation while excluding Gateway startup and peer maintenance. */
export async function withDoctorSqliteMaintenanceLock<T>(
  params: {
    env?: NodeJS.ProcessEnv;
    operation: string;
    protectedPaths?: readonly string[];
    reconcileHardlink?: (filePath: string) => Promise<void>;
    run: (authority: DoctorSqliteMaintenanceAuthority) => Promise<T> | T;
  },
  deps: DoctorSqliteMaintenanceLockDeps = {},
): Promise<T> {
  const env = params.env ?? process.env;
  const acquireLock = deps.acquireLock ?? acquireGatewayLock;
  const lockOptions = deps.lockOptions;
  let lock: Awaited<ReturnType<typeof acquireGatewayLock>>;
  try {
    lock = await acquireLock({
      ...lockOptions,
      allowInTests: true,
      env,
      pollIntervalMs: lockOptions?.pollIntervalMs ?? MAINTENANCE_LOCK_POLL_INTERVAL_MS,
      role: "sqlite-maintenance",
      timeoutMs: lockOptions?.timeoutMs ?? MAINTENANCE_LOCK_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof GatewayLockError) {
      throw new DoctorSqliteMaintenanceLockUnavailableError(params.operation, error);
    }
    throw error;
  }
  if (!lock) {
    throw new Error(`Cannot run ${params.operation} without exclusive OpenClaw state ownership.`);
  }

  let active = true;
  try {
    await assertMaintenancePathsOwnedByStateDir(
      env,
      params.operation,
      params.protectedPaths ?? [],
      params.reconcileHardlink,
    );
    return await params.run({
      assertCurrent() {
        if (!active) {
          throw new Error("Doctor SQLite maintenance authority has expired.");
        }
      },
    });
  } finally {
    active = false;
    await lock.release();
  }
}
