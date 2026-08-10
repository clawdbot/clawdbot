import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveDeviceIdentityCoordinatorPath,
  resolveDeviceIdentityCoordinatorPaths,
} from "./device-identity-coordinator-paths.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";

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

function ensurePrivateCoordinatorDirectory(lockDir: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    try {
      fs.mkdirSync(lockDir, { mode: 0o700, recursive: true });
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

type DeviceIdentityCoordinatorParams = {
  databasePath: string;
  busyTimeoutMs?: number;
} & ({ stateDir: string; lockDir?: never } | { lockDir: string; stateDir?: never });

function acquireCoordinatorDatabase(
  coordinatorPath: string,
  busyTimeoutMs: number,
): ReturnType<typeof openNodeSqliteDatabase> {
  const database = openNodeSqliteDatabase(coordinatorPath);
  try {
    database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; BEGIN EXCLUSIVE;`);
  } catch (error) {
    try {
      database.close();
    } catch {}
    throw new DeviceIdentityCoordinatorError(
      "device identity migration or creation already owns this state database",
      error,
    );
  }
  return database;
}

function releaseCoordinatorDatabase(
  database: ReturnType<typeof openNodeSqliteDatabase>,
): unknown[] {
  const releaseErrors: unknown[] = [];
  try {
    database.exec("ROLLBACK");
  } catch (error) {
    releaseErrors.push(error);
  }
  try {
    database.close();
  } catch (error) {
    releaseErrors.push(error);
  }
  return releaseErrors;
}

export function acquireDeviceIdentityCoordinator(params: DeviceIdentityCoordinatorParams): {
  release: () => void;
} {
  const timeout = Math.max(0, Math.trunc(params.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS));
  const coordinatorPaths =
    params.lockDir !== undefined
      ? [resolveDeviceIdentityCoordinatorPath(params.databasePath, params.lockDir)]
      : resolveDeviceIdentityCoordinatorPaths({
          databasePath: params.databasePath,
          stateDir: params.stateDir,
          temporaryDirectory: os.tmpdir(),
          uid: typeof process.getuid === "function" ? process.getuid() : undefined,
        });
  for (const coordinatorPath of coordinatorPaths) {
    ensurePrivateCoordinatorDirectory(path.dirname(coordinatorPath));
  }
  const databases: Array<ReturnType<typeof openNodeSqliteDatabase>> = [];
  try {
    // v2026.7.2-beta.4 through beta.7 use process temp. Keep it first until
    // those builds are no longer rolling-upgrade peers.
    for (const coordinatorPath of coordinatorPaths) {
      databases.push(acquireCoordinatorDatabase(coordinatorPath, timeout));
    }
  } catch (error) {
    const cleanupErrors = databases.toReversed().flatMap(releaseCoordinatorDatabase);
    if (cleanupErrors.length === 0) {
      throw error;
    }
    const message =
      error instanceof DeviceIdentityCoordinatorError
        ? `${error.message}; failed to clean up a partially acquired coordinator`
        : "failed to acquire and clean up device identity coordinators";
    throw new DeviceIdentityCoordinatorError(
      message,
      new AggregateError([error, ...cleanupErrors]),
    );
  }

  let released = false;
  return {
    release: () => {
      if (released) {
        return;
      }
      released = true;
      const releaseErrors = databases.toReversed().flatMap(releaseCoordinatorDatabase);
      if (releaseErrors.length > 0) {
        throw new DeviceIdentityCoordinatorError(
          "failed to release device identity coordinator",
          releaseErrors.length === 1 ? releaseErrors[0] : new AggregateError(releaseErrors),
        );
      }
    },
  };
}
