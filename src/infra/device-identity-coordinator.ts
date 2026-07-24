import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveGatewayLockDir } from "../config/paths.js";
import { requireNodeSqlite, resolveNodeSqliteLocation } from "./node-sqlite.js";

const DEFAULT_BUSY_TIMEOUT_MS = 5000;

class DeviceIdentityCoordinatorError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DeviceIdentityCoordinatorError";
  }
}

function canonicalizeDatabasePath(databasePath: string): string {
  const resolved = path.resolve(databasePath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    const missingSegments: string[] = [];
    let current = resolved;
    while (true) {
      const parent = path.dirname(current);
      if (parent === current) {
        return resolved;
      }
      missingSegments.push(path.basename(current));
      current = parent;
      try {
        return path.join(fs.realpathSync.native(current), ...missingSegments.toReversed());
      } catch {
        // Existing ancestors can still contain aliases even when the database is absent.
      }
    }
  }
}

function resolveDeviceIdentityCoordinatorPath(
  databasePath: string,
  lockDir = resolveGatewayLockDir(),
): string {
  const canonicalPath = canonicalizeDatabasePath(databasePath);
  const databaseHash = crypto.createHash("sha256").update(canonicalPath).digest("hex").slice(0, 8);
  return path.join(lockDir, `device-identity.${databaseHash}.lock.sqlite`);
}

function ensurePrivateCoordinatorDirectory(lockDir: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
        throw mkdirError;
      }
    }
    stats = fs.lstatSync(lockDir);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new DeviceIdentityCoordinatorError(
      "device identity coordinator directory must be a real directory",
    );
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && stats.uid !== uid) {
    throw new DeviceIdentityCoordinatorError(
      "device identity coordinator directory belongs to another user",
    );
  }
  if (process.platform !== "win32") {
    fs.chmodSync(lockDir, 0o700);
    const secured = fs.lstatSync(lockDir);
    if (secured.isSymbolicLink() || !secured.isDirectory() || (secured.mode & 0o077) !== 0) {
      throw new DeviceIdentityCoordinatorError(
        "device identity coordinator directory permissions are not private",
      );
    }
  }
}

export function acquireDeviceIdentityCoordinator(params: {
  databasePath: string;
  busyTimeoutMs?: number;
  lockDir?: string;
}): { release: () => void } {
  const coordinatorPath = resolveDeviceIdentityCoordinatorPath(params.databasePath, params.lockDir);
  ensurePrivateCoordinatorDirectory(path.dirname(coordinatorPath));
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(resolveNodeSqliteLocation(coordinatorPath));
  try {
    const timeout = Math.max(0, Math.trunc(params.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS));
    database.exec(`PRAGMA busy_timeout = ${timeout}; BEGIN EXCLUSIVE;`);
  } catch (error) {
    try {
      database.close();
    } catch {}
    throw new DeviceIdentityCoordinatorError(
      "device identity migration or creation already owns this state database",
      error,
    );
  }

  let released = false;
  return {
    release: () => {
      if (released) {
        return;
      }
      released = true;
      let releaseError: unknown;
      try {
        database.exec("ROLLBACK");
      } catch (error) {
        releaseError = error;
      }
      try {
        database.close();
      } catch (error) {
        releaseError ??= error;
      }
      if (releaseError) {
        throw new DeviceIdentityCoordinatorError(
          "failed to release device identity coordinator",
          releaseError,
        );
      }
    },
  };
}
