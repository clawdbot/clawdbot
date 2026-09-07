import { AsyncLocalStorage } from "node:async_hooks";
import fsSync from "node:fs";
// A paused heartbeat is not renewal. Retain the real file fence until the
// admitted operation settles, bounded by every owner's freshly read deadline.
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import {
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
  type SqliteFileGeneration,
} from "../infra/sqlite-file-generation.js";
import { acquireStateDatabaseCoordinator } from "../infra/state-database-coordinator.js";
import type { UpdateCheckpointSharedPublication } from "../infra/update-checkpoint-restore.js";
import { acquireOpenClawStateDatabaseFileExclusion } from "./openclaw-state-db-cache.js";

type LeaseExclusionParams = {
  databasePath: () => string;
  assertActive: () => void;
  readExpiry: (databasePath: string) => number;
  readPublicationExpiry: (databasePath: string) => number;
  pause: () => Promise<void>;
  resume: (expiresAt: number) => Promise<void>;
  onLost: (error: Error) => void;
};
type CaptureOwner = {
  params: LeaseExclusionParams;
  databasePath?: string;
  busy: boolean;
  cleanupAllowed: boolean;
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
  bindCaptured?: (captured: T, assertCurrent: () => void) => undefined,
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

/** The checkpoint describes facts; authority is the live lexical owners plus
 * retained physical custody. Every effect/reconciliation must finish before
 * returning: renewal after this window changes the bound lease rows.
 */
type OpenClawStateLeasePublicationResult<T> = {
  result: T;
  publication: UpdateCheckpointSharedPublication;
};

/** Canonical-only recovery CAS inside a verified, still-physically-excluded
 * publication window. The async inspections stay outside the synchronous write.
 */
type OpenClawStatePublicationWrite = (
  publication: UpdateCheckpointSharedPublication,
  write: (assertCurrent: () => void) => UpdateCheckpointSharedPublication["recoveryRecord"],
) => Promise<UpdateCheckpointSharedPublication>;
export type OpenClawStatePublicationOperation<T> = (
  assertCurrent: () => void,
  bindPublishedRecord: OpenClawStatePublicationWrite,
) => Promise<OpenClawStateLeasePublicationResult<T>>;

async function performPublication<T>(
  owners: readonly CaptureOwner[],
  databasePath: string,
  operation: OpenClawStatePublicationOperation<T>,
): Promise<T> {
  const participants = owners.map((owner) => ({ owner, expiresAt: 0, paused: false }));
  const assertActive = () => {
    for (const { owner } of participants) {
      owner.params.assertActive();
    }
  };
  const lose = (cause: unknown) => {
    for (const { owner } of participants) {
      owner.params.onLost(new Error("state lease publication refused", { cause }));
    }
  };
  let lifecycle: ReturnType<typeof acquireStateDatabaseCoordinator> | undefined;
  let exclusion: ReturnType<typeof acquireOpenClawStateDatabaseFileExclusion> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  const errors: unknown[] = [];
  let completed: OpenClawStateLeasePublicationResult<T> | undefined;
  let verifiedGeneration: SqliteFileGeneration | undefined;
  // No failed/ambiguous publication can fall through to ordinary release,
  // which might create the missing canonical DB or write an unverified copy.
  for (const owner of owners) {
    owner.cleanupAllowed = false;
  }
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
    const held = exclusion;
    const deadline = Math.min(...participants.map(({ expiresAt }) => expiresAt));
    const assertCurrent = () => {
      if (!active) {
        throw new Error("state lease publication window is closed");
      }
      assertActive();
      held.assertCurrent();
      if (Date.now() >= deadline) {
        throw new Error("state lease expired during publication");
      }
    };
    for (const owner of owners) {
      owner.assertion = assertCurrent;
    }
    timer = setTimeout(
      () => lose(new Error("state lease expired during publication")),
      Math.max(1, deadline - Date.now()),
    );
    timer.unref();
    await held.runWithSourceReads(async () => {
      // Lazy import preserves ordinary lease startup and avoids a runtime cycle.
      const { verifyUpdateCheckpointSharedPublication } =
        await import("../infra/update-checkpoint-restore.js");
      assertCurrent();
      const writes: Promise<UpdateCheckpointSharedPublication>[] = [];
      let acceptingWrites = true;
      let writing = false;
      const writeRecord: OpenClawStatePublicationWrite = async (input, write) => {
        const publication = structuredClone(input);
        try {
          assertCurrent();
          await verifyUpdateCheckpointSharedPublication(publication, databasePath);
          assertCurrent();
          for (const { owner, expiresAt } of participants) {
            if (owner.params.readPublicationExpiry(databasePath) !== expiresAt) {
              throw new Error("state lease changed before published record write");
            }
          }
          let pending: Promise<unknown> | undefined;
          try {
            await held.bindCaptured(assertCurrent, () => {
              const record = write(assertCurrent);
              if (isPromiseLike(record)) {
                pending = Promise.resolve(record);
                void pending.catch(() => undefined);
                throw new Error("published record write must complete synchronously");
              }
              publication.recoveryRecord = record;
              return undefined;
            });
          } finally {
            // The existing aperture revokes canonical capabilities and closes
            // issued handles before this invalid async callback can continue.
            await pending?.catch(() => undefined);
          }
          assertCurrent();
          await verifyUpdateCheckpointSharedPublication(publication, databasePath);
          assertCurrent();
          return publication;
        } catch (error) {
          lose(error);
          throw error;
        }
      };
      const bindPublishedRecord: OpenClawStatePublicationWrite = (input, write) => {
        assertCurrent();
        if (!acceptingWrites || writing) {
          const error = new Error("canonical publication write admission is closed or busy");
          lose(error);
          throw error;
        }
        writing = true;
        const task = writeRecord(input, write).finally(() => {
          writing = false;
        });
        writes.push(task);
        void task.catch(() => undefined);
        return task;
      };
      const operationErrors: unknown[] = [];
      try {
        completed = await operation(assertCurrent, bindPublishedRecord);
        if (writing) {
          throw new Error("publication callback returned with an unawaited canonical write");
        }
      } catch (error) {
        operationErrors.push(error);
        lose(error);
      }
      acceptingWrites = false;
      // Keep the physical fence even after callback failure. Invalid JS/async
      // writers have their handles revoked, but must settle before custody ends.
      for (const outcome of await Promise.allSettled(writes)) {
        if (outcome.status === "rejected") {
          operationErrors.push(outcome.reason);
        }
      }
      if (operationErrors.length > 0) {
        fail(operationErrors);
      }
      if (!completed) {
        throw new Error("publication callback did not return a descriptor");
      }
      assertCurrent();
      verifiedGeneration = await verifyUpdateCheckpointSharedPublication(
        completed.publication,
        databasePath,
      );
      assertCurrent();
      for (const { owner, expiresAt } of participants) {
        if (owner.params.readPublicationExpiry(databasePath) !== expiresAt) {
          throw new Error("state lease claim or expiry changed during publication");
        }
      }
      assertCurrent();
      if (
        !sameSqliteFileGeneration(verifiedGeneration, readStableSqliteFileGeneration(databasePath))
      ) {
        throw new Error("verified canonical generation changed before lease rebind");
      }
    });
    // The read-scope promise just yielded: validate again before releasing the
    // physical fence. No await follows these final facts into canonical reopen.
    assertCurrent();
    if (
      !verifiedGeneration ||
      fsSync.realpathSync(databasePath) !== databasePath ||
      !fsSync.lstatSync(databasePath).isFile() ||
      !sameSqliteFileGeneration(verifiedGeneration, readStableSqliteFileGeneration(databasePath))
    ) {
      throw new Error("canonical generation changed at lease rebind");
    }
    // No await between final facts and handoff to the canonical cache owner.
    // The outer lifecycle lock keeps new handles out throughout the transition.
    exclusion.release();
    exclusion = undefined;
    for (const { owner, expiresAt } of participants) {
      assertCurrentWithoutHandles();
      if (owner.params.readExpiry(databasePath) !== expiresAt) {
        throw new Error("state lease canonical reopen changed claim or expiry");
      }
    }
    function assertCurrentWithoutHandles() {
      assertActive();
      if (Date.now() >= deadline) {
        throw new Error("state lease expired before rebind");
      }
    }
  } catch (error) {
    errors.push(error);
    lose(error);
  }
  active = false;
  clearTimeout(timer);
  for (const owner of owners) {
    owner.assertion = undefined;
  }
  try {
    exclusion?.release();
  } catch (error) {
    errors.push(error);
    lose(error);
  }
  try {
    lifecycle?.release();
  } catch (error) {
    errors.push(error);
    lose(error);
  }
  if (errors.length === 0) {
    for (const { owner, expiresAt, paused } of participants) {
      try {
        assertActive();
        if (paused) {
          await owner.params.resume(expiresAt);
        }
        assertActive();
      } catch (error) {
        errors.push(error);
        lose(error);
      }
    }
  }
  if (errors.length > 0) {
    fail(errors);
  }
  if (!completed) {
    throw new Error("state lease publication did not complete");
  }
  // Failed lifecycle release or a later worker restart must not let an earlier
  // participant delete the original claims during lexical unwind.
  for (const owner of owners) {
    owner.cleanupAllowed = true;
  }
  return completed.result;
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
        (participants, databasePath) => performPublication(participants, databasePath, operation),
        scope,
      );
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
