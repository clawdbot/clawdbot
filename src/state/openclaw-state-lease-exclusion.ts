import { AsyncLocalStorage } from "node:async_hooks";
// A paused heartbeat is not renewal. Retain the real file fence until the
// admitted operation settles, bounded by every owner's freshly read deadline.
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import {
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
  type SqliteFileGeneration,
} from "../infra/sqlite-file-generation.js";
import { acquireStateDatabaseCoordinator } from "../infra/state-database-coordinator.js";
import { acquireOpenClawStateDatabaseFileExclusion } from "./openclaw-state-db-cache.js";
import type { OpenClawStateMutationOperation } from "./openclaw-state-lease-context.js";
import type { CaptureOwner, LeaseExclusionParams } from "./openclaw-state-lease-owner.js";
import type { OpenClawStatePublicationOperation } from "./openclaw-state-publication-types.js";
import { performOpenClawStatePublication } from "./openclaw-state-publication.js";
export type { OpenClawStatePublicationOperation } from "./openclaw-state-publication-types.js";

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
  bindCaptured?: (captured: T, assertCurrent: () => void) => undefined,
  mutation?: { run: (assertCurrent: () => void) => Promise<void>; assertCurrent: () => void },
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
  const distrustCanonical = (error: Error) => {
    for (const { owner } of participants) {
      owner.cleanupAllowed = false;
    }
    onLost(error);
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
    const assertPhysicalCurrent = () => {
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
    const assertCurrent = () => {
      assertPhysicalCurrent();
      mutation?.assertCurrent();
    };
    for (const { owner } of participants) {
      // Executor fences may themselves check these live leases. Keep the lease
      // assertion physical; the writer/capture boundary composes the executor.
      owner.assertion = assertPhysicalCurrent;
    }
    timer = setTimeout(
      () => onLost(new Error("state lease expired during file exclusion")),
      Math.max(1, deadline - Date.now()),
    );
    timer.unref();
    assertCurrent();
    if (mutation) {
      const mutationErrors: unknown[] = [];
      const before = generation.database;
      for (const { owner } of participants) {
        owner.mutationAssertion = held.assertMutationCurrent;
      }
      try {
        await held.mutate(assertCurrent, () => mutation.run(assertCurrent));
      } catch (error) {
        mutationErrors.push(error);
      } finally {
        for (const { owner } of participants) {
          owner.mutationAssertion = undefined;
        }
      }
      try {
        const after = readStableSqliteFileGeneration(databasePath);
        if (
          before.dev !== after.database.dev ||
          before.ino !== after.database.ino ||
          before.birthtimeNs !== after.database.birthtimeNs
        ) {
          throw new Error(
            "Canonical mutation replaced its source; publication authority is required",
          );
        }
        // Retained physical custody accounts for writes even on failure. This
        // only permits cleanup; failed mutation never reaches capture or binding.
        generation = after;
        await held.runWithSourceReads(async () => {
          for (const participant of participants) {
            if (
              participant.owner.params.readMutationExpiry(databasePath) !== participant.expiresAt
            ) {
              throw new Error("State lease changed during canonical mutation");
            }
          }
        });
      } catch (error) {
        mutationErrors.push(error);
      }
      if (mutationErrors.length) {
        fail(mutationErrors);
      }
      assertCurrent();
    }
    const captured = await held.runWithSourceReads(() => operation(assertCurrent));
    result = captured;
    assertCurrent();
    if (bindCaptured) {
      if (!sameSqliteFileGeneration(generation, readStableSqliteFileGeneration(databasePath))) {
        throw new Error("state lease source generation changed before binding");
      }
      const bindingErrors: unknown[] = [];
      try {
        await held.bindCaptured(assertCurrent, () => {
          const completion = bindCaptured(captured, assertCurrent);
          if (completion === undefined) {
            assertCurrent();
            for (const participant of participants) {
              if (participant.owner.params.readExpiry(databasePath) !== participant.expiresAt) {
                throw new Error("state lease changed during checkpoint binding");
              }
            }
          }
          return completion;
        });
      } catch (error) {
        bindingErrors.push(error);
      }
      try {
        const afterBinding = readStableSqliteFileGeneration(databasePath);
        // Canonical binding may update contents, never replace the source inode.
        const before = generation.database;
        const after = afterBinding.database;
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.birthtimeNs !== after.birthtimeNs
        ) {
          throw new Error("state lease source identity changed during checkpoint binding");
        }
        generation = afterBinding;
      } catch (error) {
        bindingErrors.push(error);
      }
      if (bindingErrors.length > 0) {
        fail(bindingErrors);
      }
      assertCurrent();
    }
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
      distrustCanonical(new Error("state lease source binding refused", { cause: error }));
    }
  }
  try {
    exclusion?.release();
  } catch (error) {
    errors.push(error);
    distrustCanonical(new Error("state lease file exclusion release failed", { cause: error }));
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
    distrustCanonical(new Error("state lease reopen refused", { cause: error }));
  } finally {
    try {
      lifecycle?.release();
    } catch (error) {
      errors.push(error);
      distrustCanonical(new Error("state lease exclusion release failed", { cause: error }));
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
    cleanupAllowed: true,
    admissionClosed: false,
    admitted: [],
  };
  const admit = <T>(
    operation: (participants: CaptureOwner[], databasePath: string) => Promise<T>,
    scope: readonly CaptureOwner[] = [...ancestors, owner],
  ): Promise<T> => {
    const databasePath = owner.databasePath;
    if (!databasePath) {
      throw new Error("state lease has not entered its owner scope");
    }
    const participants = scope.filter((candidate) => candidate.databasePath === databasePath);
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
    const task = operation(participants, databasePath).finally(() => {
      for (const candidate of participants) {
        candidate.busy = false;
      }
    });
    for (const candidate of participants) {
      candidate.admitted.push(task);
    }
    void task.catch(() => undefined);
    return task;
  };
  return {
    canRelease: () => owner.cleanupAllowed,
    runPublication<T>(operation: OpenClawStatePublicationOperation<T>): Promise<T> {
      const scope = activeOwners.getStore();
      if (!scope?.includes(owner)) {
        throw new Error("publication requires the live lexical lease scope");
      }
      // A retained outer context can be called inside a newer nested owner.
      // Join that CURRENT stack, so every participant also disables cleanup.
      return admit(
        (participants, databasePath) =>
          performOpenClawStatePublication(participants, databasePath, operation),
        scope,
      );
    },
    runMutation<T, R>(operation: OpenClawStateMutationOperation<T, R>): Promise<R> {
      const scope = activeOwners.getStore();
      if (!scope?.includes(owner)) {
        throw new Error("Canonical mutation requires the live lexical lease scope");
      }
      let mutated: { value: T } | undefined;
      return admit(
        (participants, databasePath) =>
          perform(
            participants,
            databasePath,
            (assertCurrent) => {
              if (!mutated) {
                throw new Error("Canonical mutation did not finish before capture");
              }
              return operation.capture(mutated.value, assertCurrent);
            },
            operation.bind,
            {
              assertCurrent: operation.assertCurrent,
              async run(assertCurrent) {
                mutated = { value: await operation.mutate(assertCurrent) };
              },
            },
          ),
        scope,
      );
    },
    assertMutationCurrent() {
      if (!owner.mutationAssertion) {
        throw new Error("a file-excluded lease cannot authorize a write transaction");
      }
      owner.mutationAssertion();
    },
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
    run<T>(
      operation: (assertCurrent: () => void) => Promise<T>,
      bindCaptured?: (captured: T, assertCurrent: () => void) => undefined,
    ): Promise<T> {
      return admit((participants, databasePath) =>
        perform(participants, databasePath, operation, bindCaptured),
      );
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
