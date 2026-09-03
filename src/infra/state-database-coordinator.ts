// Coordinates Gateway presence and shared-state lifecycle operations outside removable state.
import os from "node:os";
import path from "node:path";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { sha256HexPrefixCore } from "./crypto-digest.js";
import { tryAcquireExclusiveSqliteCoordinator } from "./node-sqlite.js";
import { isPathInside } from "./path-guards.js";
import {
  ensurePrivateSqliteCoordinatorDirectory,
  runWithSqliteCoordinator,
  SqliteCoordinatorError,
} from "./sqlite-coordinator.js";
import { getVitestResourceContext } from "./vitest-resource-ownership.js";

const heldCoordinators = new Map<
  string,
  {
    coordinator: { isReleased: () => boolean; release: () => void };
    references: number;
    releaseResourceClaims: Array<() => void>;
  }
>();

// Owned test launchers preload and freeze this process-local context before any
// application imports. Production processes have no published test context.
const vitestResourceContext = getVitestResourceContext();
const vitestResourceOwners =
  vitestResourceContext?.kind === "owned" ? vitestResourceContext.owners : [];
const productionRuntimeDirectory =
  vitestResourceContext?.kind === "owned"
    ? vitestResourceContext.productionRuntimeDirectory
    : process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Local", "OpenClaw", "locks")
      : "/tmp";

type CoordinatorFamily = "gateway-lifecycle" | "state-lifecycle";
type CoordinatorOptions = {
  databasePath: string;
  coordinatorPath?: string;
  runtimeDirectory?: string;
  uid?: number;
  busyTimeoutMs?: number;
};

function findNearestVitestResourceOwner(targetPath: string) {
  let nearest: (typeof vitestResourceOwners)[number] | undefined;
  for (const owner of vitestResourceOwners) {
    if (
      isPathInside(owner.root, targetPath) &&
      (!nearest || owner.root.length > nearest.root.length)
    ) {
      nearest = owner;
    }
  }
  return nearest;
}

function settleResourceClaims(
  releases: Array<() => void>,
  family: CoordinatorFamily,
  operation: string,
) {
  const errors: unknown[] = [];
  for (const release of releases) {
    try {
      release();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new SqliteCoordinatorError(
      `failed to ${operation} ${family} resource claim${errors.length === 1 ? "" : "s"}`,
      errors.length === 1 ? errors[0] : new AggregateError(errors),
    );
  }
}

export class StateDatabaseCoordinatorContentionError extends SqliteCoordinatorError {
  constructor(family: CoordinatorFamily) {
    super(`another OpenClaw process owns ${family}`);
    this.name = "StateDatabaseCoordinatorContentionError";
  }
}

class StateSchemaMutationConflictError extends SqliteCoordinatorError {
  constructor(databasePath: string, cause: unknown) {
    super(
      `OpenClaw refused shared state schema mutation at ${databasePath} because another Gateway owns that state directory. Stop that Gateway or perform the update through its managed restart path, then retry.`,
      cause,
    );
    this.name = "StateSchemaMutationConflictError";
  }
}

export function resolveStateLifecycleRuntimeDirectory(databasePath?: string): string {
  if (!databasePath) {
    return productionRuntimeDirectory;
  }
  const canonicalDatabasePath = resolvePathViaExistingAncestorSync(databasePath);
  return findNearestVitestResourceOwner(canonicalDatabasePath)?.root ?? productionRuntimeDirectory;
}

function resolveLifecycleCoordinatorPath(
  family: CoordinatorFamily,
  params: { databasePath: string; runtimeDirectory: string; uid: number | undefined },
): string {
  const canonicalDatabasePath = resolvePathViaExistingAncestorSync(params.databasePath);
  const requestedRuntimeDirectory = resolvePathViaExistingAncestorSync(params.runtimeDirectory);
  const defaultRuntimeDirectory = resolvePathViaExistingAncestorSync(productionRuntimeDirectory);
  const databaseOwner = findNearestVitestResourceOwner(canonicalDatabasePath);
  const requestedRuntimeOwner = findNearestVitestResourceOwner(requestedRuntimeDirectory);
  const canonicalRuntimeDirectory = databaseOwner
    ? requestedRuntimeDirectory === defaultRuntimeDirectory
      ? databaseOwner.root
      : requestedRuntimeDirectory
    : requestedRuntimeOwner
      ? defaultRuntimeDirectory
      : requestedRuntimeDirectory;
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
      runtimeDirectory:
        params.runtimeDirectory ?? resolveStateLifecycleRuntimeDirectory(params.databasePath),
      uid: params.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined),
    });
  const held = heldCoordinators.get(coordinatorPath);
  if (held) {
    held.references += 1;
  } else {
    const databaseOwner = findNearestVitestResourceOwner(
      resolvePathViaExistingAncestorSync(params.databasePath),
    );
    const coordinatorOwner =
      findNearestVitestResourceOwner(resolvePathViaExistingAncestorSync(coordinatorPath)) ??
      findNearestVitestResourceOwner(path.resolve(coordinatorPath));
    const resourceOwners = [databaseOwner, coordinatorOwner]
      .filter((owner): owner is (typeof vitestResourceOwners)[number] => owner !== undefined)
      .filter(
        (owner, index, owners) =>
          owners.findIndex((candidate) => candidate.root === owner.root) === index,
      );
    const releaseResourceClaims: Array<() => void> = [];
    try {
      for (const owner of resourceOwners) {
        releaseResourceClaims.push(owner.claim());
      }
    } catch (error) {
      try {
        settleResourceClaims(releaseResourceClaims, family, "roll back");
      } catch (releaseError) {
        throw new SqliteCoordinatorError(
          `failed to acquire ${family} resource claims safely`,
          new AggregateError([error, releaseError]),
        );
      }
      throw error;
    }
    let coordinator: ReturnType<typeof tryAcquireExclusiveSqliteCoordinator>;
    try {
      ensurePrivateSqliteCoordinatorDirectory(
        path.dirname(coordinatorPath),
        `${family} coordinator`,
      );
      coordinator = tryAcquireExclusiveSqliteCoordinator(coordinatorPath, {
        busyTimeoutMs: params.busyTimeoutMs,
      });
    } catch (error) {
      try {
        settleResourceClaims(releaseResourceClaims, family, "release");
      } catch (releaseError) {
        throw new SqliteCoordinatorError(
          `failed to acquire ${family} coordinator safely`,
          new AggregateError([error, releaseError]),
        );
      }
      throw error;
    }
    if (!coordinator) {
      settleResourceClaims(releaseResourceClaims, family, "release");
      throw new StateDatabaseCoordinatorContentionError(family);
    }
    heldCoordinators.set(coordinatorPath, { coordinator, references: 1, releaseResourceClaims });
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
        if (current.coordinator.isReleased()) {
          try {
            settleResourceClaims(current.releaseResourceClaims, family, "release");
          } catch (claimError) {
            throw new SqliteCoordinatorError(
              `failed to release ${family} coordinator and its resource claims safely`,
              new AggregateError([error, claimError]),
            );
          }
        }
        throw new SqliteCoordinatorError(`failed to release ${family} coordinator`, error);
      }
      settleResourceClaims(current.releaseResourceClaims, family, "release");
    },
  };
}

export function acquireGatewayLifecycleCoordinator(params: CoordinatorOptions) {
  return acquireLifecycleCoordinator("gateway-lifecycle", params);
}

export function acquireStateDatabaseCoordinator(params: CoordinatorOptions) {
  return acquireLifecycleCoordinator("state-lifecycle", params);
}

/** Fence schema mutation against another process's live Gateway owner. */
export function withStateSchemaFence<T>(
  params: Pick<CoordinatorOptions, "databasePath" | "runtimeDirectory" | "uid">,
  operation: () => T,
): T {
  let coordinator: ReturnType<typeof acquireGatewayLifecycleCoordinator>;
  try {
    // Never wait while the caller holds the state-lifecycle coordinator. A
    // running Gateway must win immediately so lock ordering cannot deadlock.
    coordinator = acquireGatewayLifecycleCoordinator({
      ...params,
      busyTimeoutMs: 0,
    });
  } catch (error) {
    if (error instanceof StateDatabaseCoordinatorContentionError) {
      throw new StateSchemaMutationConflictError(params.databasePath, error);
    }
    throw error;
  }
  return runWithSqliteCoordinator(coordinator, "state schema mutation", operation);
}
