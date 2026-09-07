import fsSync from "node:fs";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import {
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
  type SqliteFileGeneration,
} from "../infra/sqlite-file-generation.js";
import {
  acquireGatewayLifecycleCoordinator,
  acquireStateDatabaseCoordinator,
} from "../infra/state-database-coordinator.js";
import type { UpdateCheckpointSharedPublication } from "../infra/update-checkpoint-restore.js";
import {
  acquireOpenClawStateDatabaseFileExclusion,
  openClawStateDatabaseCache,
} from "./openclaw-state-db-cache.js";
import type { CaptureOwner } from "./openclaw-state-lease-exclusion.js";

function fail(errors: unknown[]): never {
  if (errors.length === 1) {
    throw errors[0];
  }
  throw createSqliteLifecycleAggregateError(errors, "state publication failed", errors[0]);
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

export async function performOpenClawStatePublication<T>(
  owners: readonly CaptureOwner[],
  databasePath: string,
  operation: OpenClawStatePublicationOperation<T>,
  external?: { assertCurrent: () => void; beforePublication: () => Promise<void> },
): Promise<T> {
  if (owners.length === 0 && !external) {
    throw new Error("Publication requires a live owner");
  }
  const participants = owners.map((owner) => ({ owner, expiresAt: 0, paused: false }));
  const assertActive = () => {
    external?.assertCurrent();
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
    assertActive();
    for (const participant of participants) {
      await participant.owner.params.pause();
      participant.paused = true;
      assertActive();
    }
    lifecycle = acquireStateDatabaseCoordinator({ databasePath, busyTimeoutMs: 0 });
    for (const participant of participants) {
      // Heartbeat owners are paused. This pre-publication read must not
      // create sidecars; capture's synchronous write aperture still uses its
      // normal participating read owner and never a foreign snapshot worker.
      participant.expiresAt = participant.owner.params.readMutationExpiry(databasePath);
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
    if (Number.isFinite(deadline)) {
      timer = setTimeout(
        () => lose(new Error("state lease expired during publication")),
        Math.max(1, deadline - Date.now()),
      );
      timer.unref();
    }
    await held.runWithSourceReads(async () => {
      // Lazy import preserves ordinary lease startup and avoids a runtime cycle.
      const { verifyUpdateCheckpointSharedPublication } =
        await import("../infra/update-checkpoint-restore.js");
      assertCurrent();
      await external?.beforePublication();
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

/** A fresh executor cannot claim/renew a displaced canonical DB. Reuse the same
 * physical publication engine, with Gateway exclusion and independently checked
 * writer drainage. No persisted lease/locator acts as the new executor fence. */
export async function withOpenClawStateReplayPublication<T>(
  params: {
    databasePath: string;
    assertCurrent: () => void;
    assertWritersStopped: () => Promise<void>;
  },
  operation: OpenClawStatePublicationOperation<T>,
): Promise<T> {
  params.assertCurrent();
  if (openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(params.databasePath)) {
    throw new Error("Fresh replay refuses an already opened canonical writer");
  }
  const gateway = acquireGatewayLifecycleCoordinator({
    databasePath: params.databasePath,
    busyTimeoutMs: 0,
  });
  try {
    return await performOpenClawStatePublication([], params.databasePath, operation, {
      assertCurrent: params.assertCurrent,
      beforePublication: params.assertWritersStopped,
    });
  } finally {
    gateway.release();
  }
}
