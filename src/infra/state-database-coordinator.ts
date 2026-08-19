// Coordinates Gateway presence and shared-state lifecycle operations outside removable state.
import os from "node:os";
import path from "node:path";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { sha256HexPrefixCore } from "./crypto-digest.js";
import { tryAcquireExclusiveSqliteCoordinator } from "./node-sqlite.js";
import {
  ensurePrivateSqliteCoordinatorDirectory,
  SqliteCoordinatorError,
} from "./sqlite-coordinator.js";

const heldCoordinators = new Map<
  string,
  { coordinator: { release: () => void }; references: number }
>();

type CoordinatorFamily = "gateway-lifecycle" | "state-lifecycle";
type CoordinatorOptions = {
  databasePath: string;
  coordinatorPath?: string;
  runtimeDirectory?: string;
  uid?: number;
  busyTimeoutMs?: number;
};

export function resolveStateLifecycleRuntimeDirectory(): string {
  return process.platform === "win32"
    ? path.join(os.homedir(), "AppData", "Local", "OpenClaw", "locks")
    : "/tmp";
}

function resolveLifecycleCoordinatorPath(
  family: CoordinatorFamily,
  params: { databasePath: string; runtimeDirectory: string; uid: number | undefined },
): string {
  const canonicalDatabasePath = resolvePathViaExistingAncestorSync(params.databasePath);
  const canonicalRuntimeDirectory = resolvePathViaExistingAncestorSync(params.runtimeDirectory);
  // The predecessor state-local coordinator shipped only in v2026.8.1-beta.2.
  // Keep one current stable runtime path; beta-only peers are not upgrade-compatible.
  const suffix =
    params.uid === undefined ? "openclaw-state-locks" : `openclaw-state-locks-${params.uid}`;
  return path.join(
    canonicalRuntimeDirectory,
    suffix,
    `${family}.${sha256HexPrefixCore(canonicalDatabasePath, 8)}.lock.sqlite`,
  );
}

export function resolveStateDatabaseCoordinatorPath(params: {
  databasePath: string;
  runtimeDirectory: string;
  uid: number | undefined;
}): string {
  return resolveLifecycleCoordinatorPath("state-lifecycle", params);
}

function acquireLifecycleCoordinator(
  family: CoordinatorFamily,
  params: CoordinatorOptions,
): { path: string; release: () => void } {
  const coordinatorPath =
    params.coordinatorPath ??
    resolveLifecycleCoordinatorPath(family, {
      databasePath: params.databasePath,
      runtimeDirectory: params.runtimeDirectory ?? resolveStateLifecycleRuntimeDirectory(),
      uid: params.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined),
    });
  const held = heldCoordinators.get(coordinatorPath);
  if (held) {
    held.references += 1;
  } else {
    ensurePrivateSqliteCoordinatorDirectory(path.dirname(coordinatorPath), `${family} coordinator`);
    const coordinator = tryAcquireExclusiveSqliteCoordinator(coordinatorPath, {
      busyTimeoutMs: params.busyTimeoutMs,
    });
    if (!coordinator) {
      throw new SqliteCoordinatorError(`another OpenClaw process owns ${family}`);
    }
    heldCoordinators.set(coordinatorPath, { coordinator, references: 1 });
  }

  let released = false;
  return {
    path: coordinatorPath,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      const current = heldCoordinators.get(coordinatorPath);
      if (!current) {
        return;
      }
      current.references -= 1;
      if (current.references > 0) {
        return;
      }
      heldCoordinators.delete(coordinatorPath);
      try {
        current.coordinator.release();
      } catch (error) {
        throw new SqliteCoordinatorError(`failed to release ${family} coordinator`, error);
      }
    },
  };
}

export function acquireGatewayLifecycleCoordinator(params: CoordinatorOptions) {
  return acquireLifecycleCoordinator("gateway-lifecycle", params);
}

export function acquireStateDatabaseCoordinator(params: CoordinatorOptions) {
  return acquireLifecycleCoordinator("state-lifecycle", params);
}
