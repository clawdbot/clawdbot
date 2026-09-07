// A paused heartbeat is not renewal. Retain the real file fence until the
// admitted operation settles, bounded by every owner's freshly read deadline.
import { AsyncLocalStorage } from "node:async_hooks";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import {
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
  type SqliteFileGeneration,
} from "../infra/sqlite-file-generation.js";
import { acquireStateDatabaseCoordinator } from "../infra/state-database-coordinator.js";
import { acquireOpenClawStateDatabaseFileExclusion } from "./openclaw-state-db-cache.js";

type LeaseExclusionParams = {
  databasePath: () => string;
  assertActive: () => void;
  readExpiry: (databasePath: string) => number;
  pause: () => Promise<void>;
  resume: (expiresAt: number) => Promise<void>;
  onLost: (error: Error) => void;
};
type CaptureOwner = {
  params: LeaseExclusionParams;
  databasePath?: string;
  busy: boolean;
  admissionClosed: boolean;
  assertion?: () => void;
  admitted: Promise<unknown>[];
};
// Only live lexical owners are composed. Other tasks/processes remain foreign
// handles; neither a pathname nor inherited serialized data grants admission.
const activeOwners = new AsyncLocalStorage<readonly CaptureOwner[]>();

function fail(errors: unknown[]): never {
  if (errors.length === 1) {
    throw errors[0];
  }
  throw createSqliteLifecycleAggregateError(errors, "state lease exclusion failed", errors[0]);
}

async function perform<T>(
  owners: readonly CaptureOwner[],
  databasePath: string,
  operation: (assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  const errors: unknown[] = [];
  const participants = owners.map<{
    owner: CaptureOwner;
    paused: boolean;
    expiresAt?: number;
  }>((owner) => ({ owner, paused: false }));
  const assertActive = () => {
    for (const { owner } of participants) {
      owner.params.assertActive();
    }
  };
  const onLost = (error: Error) => {
    for (const { owner } of participants) {
      owner.params.onLost(error);
    }
  };
  let result: T | undefined;
  let lifecycle: ReturnType<typeof acquireStateDatabaseCoordinator> | undefined;
  let exclusion: ReturnType<typeof acquireOpenClawStateDatabaseFileExclusion> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation: SqliteFileGeneration | undefined;
  let active = true;
  try {
    for (const participant of participants) {
      await participant.owner.params.pause();
      participant.paused = true;
      assertActive();
    }
    lifecycle = acquireStateDatabaseCoordinator({ databasePath, busyTimeoutMs: 0 });
    for (const participant of participants) {
      participant.expiresAt = participant.owner.params.readExpiry(databasePath);
    }
    exclusion = acquireOpenClawStateDatabaseFileExclusion(databasePath);
    generation = readStableSqliteFileGeneration(databasePath);
    const held = exclusion;
    const deadline = Math.min(...participants.map((participant) => participant.expiresAt ?? 0));
    const assertCurrent = () => {
      if (!active) {
        throw new Error("state lease file exclusion is no longer current");
      }
      assertActive();
      held.assertCurrent();
      if (Date.now() >= deadline) {
        const error = new Error("state lease expired during file exclusion");
        onLost(error);
        throw error;
      }
    };
    for (const { owner } of participants) {
      owner.assertion = assertCurrent;
    }
    timer = setTimeout(
      () => onLost(new Error("state lease expired during file exclusion")),
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
  for (const { owner } of participants) {
    owner.assertion = undefined;
  }
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
      onLost(new Error("state lease source binding refused", { cause: error }));
    }
  }
  try {
    exclusion?.release();
  } catch (error) {
    errors.push(error);
    onLost(new Error("state lease file exclusion release failed", { cause: error }));
  }
  // Reopen the same generation under lifecycle admission and check every exact
  // original owner/expiry before releasing it to renewal. This is not restore.
  try {
    assertActive();
    for (const participant of participants) {
      const reopenedExpiry = participant.owner.params.readExpiry(databasePath);
      if (participant.expiresAt !== undefined && reopenedExpiry !== participant.expiresAt) {
        throw new Error("state lease changed during file exclusion");
      }
      participant.expiresAt = reopenedExpiry;
    }
  } catch (error) {
    errors.push(error);
    onLost(new Error("state lease reopen refused", { cause: error }));
  } finally {
    try {
      lifecycle?.release();
    } catch (error) {
      errors.push(error);
      onLost(new Error("state lease exclusion release failed", { cause: error }));
    }
  }
  for (const participant of participants) {
    try {
      assertActive();
      if (participant.expiresAt === undefined) {
        throw new Error("state lease has no current durable expiry");
      }
      if (participant.paused) {
        await participant.owner.params.resume(participant.expiresAt);
      }
      assertActive();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    fail(errors);
  }
  // SAFETY: successful operation assigned result; every failure above is rethrown.
  return result as T;
}

export function createOpenClawStateLeaseExclusion(params: LeaseExclusionParams) {
  const ancestors = activeOwners.getStore() ?? [];
  const owner: CaptureOwner = {
    params,
    busy: false,
    admissionClosed: false,
    admitted: [],
  };
  return {
    runWithOwnerScope<T>(operation: () => Promise<T>): Promise<T> {
      // Resolve only inside the lease's protected callback entry/cleanup scope.
      params.assertActive();
      owner.databasePath = params.databasePath();
      return activeOwners.run([...ancestors, owner], operation);
    },
    assertIfExcluded() {
      if (!owner.assertion) {
        if (owner.busy) {
          throw new Error("state lease file exclusion is transitioning");
        }
        return false;
      }
      owner.assertion();
      return true;
    },
    run<T>(operation: (assertCurrent: () => void) => Promise<T>): Promise<T> {
      const databasePath = owner.databasePath;
      if (!databasePath) {
        throw new Error("state lease has not entered its owner scope");
      }
      const participants = [...ancestors, owner].filter(
        (candidate) => candidate.databasePath === databasePath,
      );
      for (const candidate of participants) {
        candidate.params.assertActive();
        if (candidate.admissionClosed) {
          throw new Error("state lease no longer accepts file exclusion");
        }
        if (candidate.busy) {
          throw new Error("state lease file exclusion is already in progress");
        }
        if (candidate.params.databasePath() !== databasePath) {
          throw new Error("state lease database path changed during exclusion");
        }
      }
      for (const candidate of participants) {
        candidate.busy = true;
      }
      const task = perform(participants, databasePath, operation).finally(() => {
        for (const candidate of participants) {
          candidate.busy = false;
        }
      });
      for (const candidate of participants) {
        candidate.admitted.push(task);
      }
      // Every participating owner drains this same work before cleanup/return.
      void task.catch(() => undefined);
      return task;
    },
    async drain() {
      const errors: unknown[] = [];
      let drained = 0;
      while (drained < owner.admitted.length) {
        const batch = owner.admitted.slice(drained);
        drained += batch.length;
        const results = await Promise.allSettled(batch);
        for (const result of results) {
          if (result.status === "rejected") {
            errors.push(result.reason);
          }
        }
      }
      // Close admission in the same turn as the final empty check.
      owner.admissionClosed = true;
      if (errors.length > 0) {
        fail(errors);
      }
    },
  };
}
