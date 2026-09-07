// A paused heartbeat is not renewal. Retain the real file fence until the
// admitted operation settles, bounded by its freshly read durable deadline.
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import {
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
  type SqliteFileGeneration,
} from "../infra/sqlite-file-generation.js";
import { acquireStateDatabaseCoordinator } from "../infra/state-database-coordinator.js";
import { acquireOpenClawStateDatabaseFileExclusion } from "./openclaw-state-db-cache.js";

export function createOpenClawStateLeaseExclusion(params: {
  databasePath: () => string;
  assertActive: () => void;
  readExpiry: (databasePath: string) => number;
  pause: () => Promise<void>;
  resume: (expiresAt: number) => Promise<void>;
  onLost: (error: Error) => void;
}) {
  let busy = false;
  let admissionClosed = false;
  let assertion: (() => void) | undefined;
  const admitted: Promise<unknown>[] = [];
  const fail = (errors: unknown[]): never => {
    if (errors.length === 1) {
      throw errors[0];
    }
    throw createSqliteLifecycleAggregateError(errors, "state lease exclusion failed", errors[0]);
  };
  const perform = async <T>(operation: (assertCurrent: () => void) => Promise<T>): Promise<T> => {
    const errors: unknown[] = [];
    let result: T | undefined;
    let expiresAt: number | undefined;
    let lifecycle: ReturnType<typeof acquireStateDatabaseCoordinator> | undefined;
    let exclusion: ReturnType<typeof acquireOpenClawStateDatabaseFileExclusion> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation: SqliteFileGeneration | undefined;
    let active = true;
    let paused = false;
    const databasePath = params.databasePath();
    try {
      await params.pause();
      paused = true;
      params.assertActive();
      lifecycle = acquireStateDatabaseCoordinator({ databasePath, busyTimeoutMs: 0 });
      expiresAt = params.readExpiry(databasePath);
      exclusion = acquireOpenClawStateDatabaseFileExclusion(databasePath);
      generation = readStableSqliteFileGeneration(databasePath);
      const held = exclusion;
      const deadline = expiresAt;
      const assertCurrent = () => {
        if (!active) {
          throw new Error("state lease file exclusion is no longer current");
        }
        params.assertActive();
        held.assertCurrent();
        if (Date.now() >= deadline) {
          const error = new Error("state lease expired during file exclusion");
          params.onLost(error);
          throw error;
        }
      };
      assertion = assertCurrent;
      timer = setTimeout(
        () => params.onLost(new Error("state lease expired during file exclusion")),
        Math.max(1, deadline - Date.now()),
      );
      timer.unref();
      assertCurrent();
      result = await held.runWithSourceReads(() => operation(assertCurrent));
      assertCurrent();
    } catch (error) {
      errors.push(error);
    }
    active = false;
    assertion = undefined;
    clearTimeout(timer);
    if (exclusion) {
      try {
        exclusion.assertCurrent();
        if (
          !generation ||
          !sameSqliteFileGeneration(generation, readStableSqliteFileGeneration(databasePath))
        ) {
          throw new Error("state lease source generation changed during capture");
        }
      } catch (error) {
        errors.push(error);
        params.onLost(new Error("state lease source binding refused", { cause: error }));
      }
    }
    try {
      exclusion?.release();
    } catch (error) {
      errors.push(error);
      params.onLost(new Error("state lease file exclusion release failed", { cause: error }));
    }
    // Capture is read-only. Reopen only the same generation while lifecycle
    // admission remains held, then require the unchanged original durable lease.
    // Actual restore publication needs its own verified transition, not this API.
    try {
      params.assertActive();
      const reopenedExpiry = params.readExpiry(databasePath);
      if (expiresAt !== undefined && reopenedExpiry !== expiresAt) {
        throw new Error("state lease changed during file exclusion");
      }
      expiresAt = reopenedExpiry;
    } catch (error) {
      errors.push(error);
      params.onLost(new Error("state lease reopen refused", { cause: error }));
    } finally {
      try {
        lifecycle?.release();
      } catch (error) {
        errors.push(error);
        params.onLost(new Error("state lease exclusion release failed", { cause: error }));
      }
    }
    try {
      params.assertActive();
      if (expiresAt === undefined) {
        throw new Error("state lease has no current durable expiry");
      }
      if (paused) {
        await params.resume(expiresAt);
      }
      params.assertActive();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      fail(errors);
    }
    // SAFETY: the successful operation assigned result; every failure above is rethrown.
    return result as T;
  };
  return {
    assertIfExcluded() {
      if (!assertion) {
        if (busy) {
          throw new Error("state lease file exclusion is transitioning");
        }
        return false;
      }
      assertion();
      return true;
    },
    run<T>(operation: (assertCurrent: () => void) => Promise<T>): Promise<T> {
      params.assertActive();
      if (admissionClosed) {
        throw new Error("state lease no longer accepts file exclusion");
      }
      if (busy) {
        throw new Error("state lease file exclusion is already in progress");
      }
      busy = true;
      const task = perform(operation).finally(() => {
        busy = false;
      });
      admitted.push(task);
      // The owner always drains admitted work, including detached caller work.
      void task.catch(() => undefined);
      return task;
    },
    async drain() {
      const errors: unknown[] = [];
      let drained = 0;
      while (drained < admitted.length) {
        const batch = admitted.slice(drained);
        drained += batch.length;
        const results = await Promise.allSettled(batch);
        for (const result of results) {
          if (result.status === "rejected") {
            errors.push(result.reason);
          }
        }
      }
      // Close admission in the same turn as the final empty check: a later
      // promise reaction cannot add work between drainage and owner cleanup.
      admissionClosed = true;
      if (errors.length > 0) {
        fail(errors);
      }
    },
  };
}
