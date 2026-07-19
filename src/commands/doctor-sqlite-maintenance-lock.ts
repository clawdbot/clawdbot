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

function assertMaintenancePathsOwnedByStateDir(
  env: NodeJS.ProcessEnv,
  operation: string,
  protectedPaths: readonly string[],
): void {
  if (protectedPaths.length === 0) {
    return;
  }
  const stateDir = path.resolve(resolveStateDir(env));
  const stateCanonicalDir = resolvePathViaExistingAncestorSync(stateDir);
  for (const protectedPath of protectedPaths) {
    const absolutePath = path.resolve(protectedPath);
    let resolvedPath: ReturnType<typeof resolveRootPathSync>;
    try {
      if (!isPathInside(stateDir, absolutePath) && !isPathInside(stateCanonicalDir, absolutePath)) {
        throw new Error("path is not lexically owned by the active state directory");
      }
      resolvedPath = resolveRootPathSync({
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
    if (
      resolvedPath.exists &&
      resolvedPath.kind === "file" &&
      fs.statSync(resolvedPath.canonicalPath).nlink > 1
    ) {
      throw new Error(
        `Cannot run ${operation} for a hard-linked path: ${protectedPath}. Remove the additional hard link and retry.`,
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
    run: () => Promise<T> | T;
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

  try {
    assertMaintenancePathsOwnedByStateDir(env, params.operation, params.protectedPaths ?? []);
    return await params.run();
  } finally {
    await lock.release();
  }
}
