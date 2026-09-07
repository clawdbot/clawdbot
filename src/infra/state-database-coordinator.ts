// Coordinates Gateway presence and shared-state lifecycle operations outside removable state.
import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import path from "node:path";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { sha256HexPrefixCore } from "./crypto-digest.js";
import {
  createSqliteLifecycleAggregateError,
  ensurePrivateSqliteCoordinatorDirectory,
  runWithSqliteCoordinator,
  SqliteCoordinatorError,
  tryAcquireExclusiveSqliteCoordinator,
  tryAcquireSharedSqliteCoordinator,
} from "./sqlite-coordinator.js";

const heldCoordinators = new Map<
  string,
  { coordinator: { release: () => void }; references: number }
>();

type SourceReadScope = {
  active: boolean;
  mutation?: boolean;
  assertCurrent: () => void;
  pin: () => { release: () => void };
  snapshot?: () => Promise<{ location: string; cleanup: () => boolean }>;
  snapshots?: Promise<unknown>[];
};
const sourceReadScopes = new AsyncLocalStorage<ReadonlyMap<string, SourceReadScope>>();
const canonicalWriteScopes = new AsyncLocalStorage<ReadonlyMap<string, SourceReadScope>>();

type CoordinatorFamily = "gateway-lifecycle" | "state-lifecycle" | "state-handles";
type CoordinatorOptions = {
  databasePath: string;
  coordinatorPath?: string;
  runtimeDirectory?: string;
  uid?: number;
  busyTimeoutMs?: number;
};

export class StateDatabaseCoordinatorContentionError extends SqliteCoordinatorError {
  constructor(family: CoordinatorFamily) {
    super(`another OpenClaw process owns ${family}`);
    this.name = "StateDatabaseCoordinatorContentionError";
  }
}

export class StateSchemaMutationConflictError extends SqliteCoordinatorError {
  constructor(databasePath: string, cause: unknown) {
    super(
      `OpenClaw refused shared state schema mutation at ${databasePath} because another Gateway owns that state directory. Stop that Gateway or perform the update through its managed restart path, then retry.`,
      cause,
    );
    this.name = "StateSchemaMutationConflictError";
  }
}

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
      throw new StateDatabaseCoordinatorContentionError(family);
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
  // Lifecycle ownership is reentrant for nested transactions. File publication
  // is not: even this process must refuse before ownership probes touch SQLite.
  const handlesPath = resolveLifecycleCoordinatorPath("state-handles", {
    databasePath: params.databasePath,
    runtimeDirectory: params.runtimeDirectory ?? resolveStateLifecycleRuntimeDirectory(),
    uid: params.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined),
  });
  const writeScope = canonicalWriteScopes.getStore()?.get(handlesPath);
  if (writeScope) {
    if (!writeScope.active) {
      throw new SqliteCoordinatorError("SQLite binding write scope is no longer current");
    }
    writeScope.assertCurrent();
  } else if (heldCoordinators.has(handlesPath)) {
    throw new StateDatabaseCoordinatorContentionError("state-handles");
  }
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

/** A live cached connection excludes file publication, not other cached connections. */
export function acquireStateDatabaseHandleLease(params: CoordinatorOptions) {
  const pathname =
    params.coordinatorPath ??
    resolveLifecycleCoordinatorPath("state-handles", {
      databasePath: params.databasePath,
      runtimeDirectory: params.runtimeDirectory ?? resolveStateLifecycleRuntimeDirectory(),
      uid: params.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined),
    });
  const writeScope = canonicalWriteScopes.getStore()?.get(pathname);
  if (writeScope) {
    if (!writeScope.active) {
      throw new SqliteCoordinatorError("SQLite binding write scope is no longer current");
    }
    writeScope.assertCurrent();
    return writeScope.pin();
  }
  const sourceScope = sourceReadScopes.getStore()?.get(pathname);
  if (sourceScope?.active) {
    sourceScope.assertCurrent();
    return sourceScope.pin();
  }
  ensurePrivateSqliteCoordinatorDirectory(path.dirname(pathname), "state-handles coordinator");
  const coordinator = tryAcquireSharedSqliteCoordinator(pathname, {
    busyTimeoutMs: params.busyTimeoutMs,
  });
  if (!coordinator) {
    throw new StateDatabaseCoordinatorContentionError("state-handles");
  }
  return coordinator;
}

/** Acquire only after closing local cached owners under the state lifecycle gate. */
export function acquireStateDatabaseHandleExclusion(params: CoordinatorOptions) {
  const coordinator = acquireLifecycleCoordinator("state-handles", params);
  const owner = heldCoordinators.get(coordinator.path);
  // Only the returned owner can create internal read pins. A second public
  // acquisition must not borrow another task's process-local exclusion.
  if (!owner || owner.references !== 1) {
    coordinator.release();
    throw new StateDatabaseCoordinatorContentionError("state-handles");
  }
  let released = false;
  const assertCurrent = () => {
    if (released || heldCoordinators.get(coordinator.path) !== owner) {
      throw new SqliteCoordinatorError("SQLite source exclusion is no longer current");
    }
  };
  const pin = () => {
    assertCurrent();
    return acquireLifecycleCoordinator("state-handles", {
      ...params,
      coordinatorPath: coordinator.path,
    });
  };
  return {
    assertCurrent,
    release() {
      released = true;
      coordinator.release();
    },
    assertNoPins() {
      assertCurrent();
      if (owner.references !== 1) {
        throw new SqliteCoordinatorError("SQLite mutation left a participating handle open");
      }
    },
    assertMutationCurrent(this: void) {
      const scope = canonicalWriteScopes.getStore()?.get(coordinator.path);
      if (!scope?.active || !scope.mutation) {
        throw new SqliteCoordinatorError("SQLite canonical mutation scope is closed");
      }
      scope.assertCurrent();
    },
    async runWithCanonicalMutation<T>(
      assertAuthority: () => void,
      operation: () => Promise<T>,
      snapshot: (
        assertCurrent: () => void,
      ) => Promise<{ location: string; cleanup: () => boolean }>,
    ): Promise<T> {
      const retained = pin();
      const snapshots: Promise<unknown>[] = [];
      const scope: SourceReadScope = {
        active: true,
        mutation: true,
        snapshots,
        assertCurrent: () => {
          assertCurrent();
          assertAuthority();
        },
        pin,
      };
      const scopes = new Map(canonicalWriteScopes.getStore());
      scopes.set(coordinator.path, scope);
      scope.snapshot = () =>
        snapshot(() => {
          if (!scope.active) {
            throw new SqliteCoordinatorError("SQLite mutation inspection scope is closed");
          }
          scope.assertCurrent();
        });
      try {
        scope.assertCurrent();
        const result = await canonicalWriteScopes.run(scopes, operation);
        scope.assertCurrent();
        return result;
      } finally {
        // Close admission first, then join any snapshot that escaped its caller.
        // An escaped operation cannot use this context after the owner returns.
        scope.active = false;
        await Promise.allSettled(snapshots);
        retained.release();
      }
    },
    assertDrainedDuringMutation() {
      assertCurrent();
      if (owner.references !== 2) {
        throw new SqliteCoordinatorError("SQLite inspection requires drained source handles");
      }
    },
    // Synchronous admission only. Inherited async contexts cannot continue
    // canonical writes after this callback returns, even after fence release.
    runWithCanonicalWrites<T>(this: void, assertAuthority: () => void, operation: () => T): T {
      const retained = pin();
      const scope: SourceReadScope = {
        active: true,
        assertCurrent: () => {
          assertCurrent();
          assertAuthority();
        },
        pin,
      };
      const scopes = new Map(canonicalWriteScopes.getStore());
      scopes.set(coordinator.path, scope);
      try {
        // Preserve even an invalid asynchronous result for the owning cache
        // boundary to drain after this synchronous admission has been revoked.
        return runWithSqliteCoordinator(retained, "SQLite binding write scope", () => {
          scope.assertCurrent();
          return { result: canonicalWriteScopes.run(scopes, operation) };
        }).result;
      } finally {
        scope.active = false;
      }
    },
    async runWithSourceReads<T>(
      this: void,
      operation: (assertCurrent: () => void) => Promise<T>,
    ): Promise<T> {
      const retained = pin();
      const scope: SourceReadScope = { active: true, assertCurrent, pin };
      const scopes = new Map(sourceReadScopes.getStore());
      scopes.set(coordinator.path, scope);
      let result: T;
      try {
        result = await sourceReadScopes.run(scopes, () => operation(assertCurrent));
        assertCurrent();
      } catch (error) {
        scope.active = false;
        try {
          retained.release();
        } catch (releaseError) {
          throw createSqliteLifecycleAggregateError(
            [error, releaseError],
            "SQLite excluded read and release both failed",
            error,
          );
        }
        throw error;
      }
      scope.active = false;
      retained.release();
      return result;
    },
  };
}

/** Only a live process-local exclusion owner may copy its already-drained source. */
export function hasStateDatabaseSourceExclusion(databasePath: string): boolean {
  const pathname = resolveLifecycleCoordinatorPath("state-handles", {
    databasePath,
    runtimeDirectory: resolveStateLifecycleRuntimeDirectory(),
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
  });
  const scope = sourceReadScopes.getStore()?.get(pathname);
  if (!scope?.active) {
    return false;
  }
  scope.assertCurrent();
  return true;
}

/** The mutation owner alone supplies private snapshots while its native source
 * may still be open. This never authorizes a child process or a source reopen. */
export function prepareStateDatabaseMutationSnapshot(databasePath: string) {
  const pathname = resolveLifecycleCoordinatorPath("state-handles", {
    databasePath,
    runtimeDirectory: resolveStateLifecycleRuntimeDirectory(),
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
  });
  const scope = canonicalWriteScopes.getStore()?.get(pathname);
  if (!scope?.mutation) {
    return undefined;
  }
  if (!scope.active || !scope.snapshot || !scope.snapshots) {
    throw new SqliteCoordinatorError("SQLite mutation inspection scope is closed");
  }
  scope.assertCurrent();
  const pending = scope.snapshot();
  scope.snapshots.push(pending);
  void pending.catch(() => undefined);
  return pending;
}
