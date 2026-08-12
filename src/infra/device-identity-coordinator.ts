import os from "node:os";
import path from "node:path";
import {
  resolveDeviceIdentityCoordinatorPath,
  resolveDeviceIdentityCoordinatorPaths,
} from "./device-identity-coordinator-paths.js";
import { tryAcquireExclusiveSqliteCoordinator } from "./node-sqlite.js";
import {
  ensurePrivateSqliteCoordinatorDirectory,
  SqliteCoordinatorError,
} from "./sqlite-coordinator.js";

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

type DeviceIdentityCoordinatorParams = {
  databasePath: string;
  busyTimeoutMs?: number;
} & ({ stateDir: string; lockDir?: never } | { lockDir: string; stateDir?: never });

function releaseCoordinators(coordinators: Array<{ release: () => void }>): unknown[] {
  const errors: unknown[] = [];
  for (const coordinator of coordinators.toReversed()) {
    try {
      coordinator.release();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function acquireCoordinator(
  coordinatorPath: string,
  busyTimeoutMs: number,
): { release: () => void } {
  const message = "device identity migration or creation already owns this state database";
  try {
    const coordinator = tryAcquireExclusiveSqliteCoordinator(coordinatorPath, { busyTimeoutMs });
    if (coordinator) {
      return coordinator;
    }
    throw new DeviceIdentityCoordinatorError(message);
  } catch (error) {
    if (error instanceof DeviceIdentityCoordinatorError) {
      throw error;
    }
    throw new DeviceIdentityCoordinatorError(message, error);
  }
}

function ensurePrivateDeviceIdentityCoordinatorDirectory(directoryPath: string): void {
  try {
    ensurePrivateSqliteCoordinatorDirectory(directoryPath, "device identity coordinator");
  } catch (error) {
    if (error instanceof SqliteCoordinatorError) {
      throw new DeviceIdentityCoordinatorError(error.message, error.cause);
    }
    throw error;
  }
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
    ensurePrivateDeviceIdentityCoordinatorDirectory(path.dirname(coordinatorPath));
  }
  const coordinators: Array<{ release: () => void }> = [];
  try {
    // v2026.7.2-beta.4 through beta.7 use process temp. Keep it first until
    // those builds are no longer rolling-upgrade peers.
    for (const coordinatorPath of coordinatorPaths) {
      coordinators.push(acquireCoordinator(coordinatorPath, timeout));
    }
  } catch (error) {
    const cleanupErrors = releaseCoordinators(coordinators);
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
      const releaseErrors = releaseCoordinators(coordinators);
      if (releaseErrors.length > 0) {
        throw new DeviceIdentityCoordinatorError(
          "failed to release device identity coordinator",
          releaseErrors.length === 1 ? releaseErrors[0] : new AggregateError(releaseErrors),
        );
      }
    },
  };
}
