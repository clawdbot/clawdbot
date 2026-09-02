import fs from "node:fs/promises";
import path from "node:path";
import { inheritMatrixQaReplacementRelation, type MatrixQaObservedEvent } from "./events.js";

export type MatrixQaE2eeActorId = "driver" | "observer" | `driver-${string}` | `cli-${string}`;

export const MATRIX_QA_E2EE_SYNC_FILTER = {
  room: {
    ephemeral: { not_types: ["m.receipt"] },
  },
};

async function withMatrixQaE2eeTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(message));
    }, timeoutMs);
    timer.unref();
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function createMatrixQaE2eeClientLifecycle(params: {
  detachListeners: () => void;
  drainPendingDecryptions: () => Promise<void>;
  shutdownTimeoutMs: number;
  stopAndPersist: () => Promise<void>;
  stopWithoutPersist: () => Promise<void>;
}) {
  const activeOperations = new Set<Promise<unknown>>();
  let shutdownStarted = false;
  let stopPromise: Promise<void> | undefined;

  const failShutdown = async (phase: string, cause: unknown): Promise<never> => {
    try {
      await params.stopWithoutPersist();
    } catch {
      // Preserve the lifecycle failure that explains why persistence was skipped.
    }
    throw new Error(
      `Matrix E2EE client shutdown failed while ${phase}; crypto state was discarded. Retry the QA scenario with a fresh client.`,
      { cause },
    );
  };
  const stop = (): Promise<void> => {
    if (stopPromise) {
      return stopPromise;
    }
    shutdownStarted = true;
    stopPromise = (async () => {
      const deadline = Date.now() + params.shutdownTimeoutMs;
      params.detachListeners();
      if (activeOperations.size > 0) {
        const graceMs = Math.min(1_000, Math.max(0, deadline - Date.now()));
        await withMatrixQaE2eeTimeout(
          Promise.allSettled(activeOperations),
          graceMs,
          "active Matrix SDK operations did not settle before shutdown",
        ).catch((error: unknown) =>
          failShutdown("waiting for active Matrix SDK operations", error),
        );
      }
      await withMatrixQaE2eeTimeout(
        params.drainPendingDecryptions(),
        Math.max(0, deadline - Date.now()),
        "pending Matrix decryptions did not drain before shutdown",
      ).catch((error: unknown) => failShutdown("draining pending Matrix decryptions", error));
      await params.stopAndPersist();
    })();
    return stopPromise;
  };

  const runMatrixQaE2eeClientOperation = async <T>(operation: {
    label: string;
    run: () => Promise<T>;
    timeoutMs: number;
  }): Promise<T> => {
    if (shutdownStarted) {
      throw new Error(
        `Matrix E2EE client shutdown has started; cannot start ${operation.label}. Retry the QA scenario with a fresh client.`,
      );
    }
    const active = operation.run();
    activeOperations.add(active);
    void active.finally(() => activeOperations.delete(active)).catch(() => undefined);

    return withMatrixQaE2eeTimeout(
      active,
      operation.timeoutMs,
      `${operation.label} timed out after ${operation.timeoutMs}ms`,
      () => void stop().catch(() => undefined),
    );
  };

  return { runOperation: runMatrixQaE2eeClientOperation, stop };
}

function shouldRecordMatrixQaObservedEventUpdate(params: {
  next: MatrixQaObservedEvent;
  previous: MatrixQaObservedEvent | undefined;
}) {
  const previous = params.previous;
  if (!previous) {
    return true;
  }
  const next = params.next;
  return (
    (previous.body === undefined && next.body !== undefined) ||
    (previous.formattedBody === undefined && next.formattedBody !== undefined) ||
    (previous.msgtype === undefined && next.msgtype !== undefined) ||
    (previous.relatesTo === undefined && next.relatesTo !== undefined) ||
    (previous.mentions === undefined && next.mentions !== undefined) ||
    (previous.attachment === undefined && next.attachment !== undefined)
  );
}

export function createMatrixQaE2eeObservedEventRecorder(params: {
  append: (event: MatrixQaObservedEvent) => void;
}) {
  const eventsById = new Map<string, MatrixQaObservedEvent>();
  const replacementIdsByTargetId = new Map<string, Set<string>>();

  const append = (event: MatrixQaObservedEvent) => {
    eventsById.set(event.eventId, event);
    params.append(event);
  };

  const rehydrateReplacements = (target: MatrixQaObservedEvent) => {
    if (!target.relatesTo) {
      return;
    }
    for (const replacementId of replacementIdsByTargetId.get(target.eventId) ?? []) {
      const replacement = eventsById.get(replacementId);
      if (!replacement || replacement.relatesTo) {
        continue;
      }
      const rehydrated = inheritMatrixQaReplacementRelation({
        event: replacement,
        replacedEvent: target,
      });
      if (rehydrated !== replacement) {
        // Waiters scan append-only history from a cursor, so relation enrichment
        // must be observable as a new record rather than an in-place mutation.
        append(rehydrated);
      }
    }
  };

  return {
    record(normalized: MatrixQaObservedEvent | null) {
      if (!normalized) {
        return;
      }
      const observed = inheritMatrixQaReplacementRelation({
        event: normalized,
        replacedEvent: normalized.replacesEventId
          ? eventsById.get(normalized.replacesEventId)
          : undefined,
      });
      if (
        !shouldRecordMatrixQaObservedEventUpdate({
          next: observed,
          previous: eventsById.get(observed.eventId),
        })
      ) {
        return;
      }
      if (observed.replacesEventId) {
        const replacementIds =
          replacementIdsByTargetId.get(observed.replacesEventId) ?? new Set<string>();
        replacementIds.add(observed.eventId);
        replacementIdsByTargetId.set(observed.replacesEventId, replacementIds);
      }
      append(observed);
      rehydrateReplacements(observed);
    },
  };
}

function buildMatrixQaE2eeStoragePaths(params: {
  actorId: MatrixQaE2eeActorId;
  outputDir: string;
  scenarioId: string;
}) {
  const rootDir = path.join(params.outputDir, "matrix-e2ee", "accounts", params.actorId);
  const accountDir = path.join(rootDir, "account");
  const runKey = path
    .basename(params.outputDir)
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .slice(-80);
  const actorKey = params.actorId.replace(/[^A-Za-z0-9_-]/g, "-").slice(-40);
  return {
    accountDir,
    cryptoDatabasePrefix: `qa-lab-matrix-${runKey || "run"}-${actorKey || "actor"}`,
    idbSnapshotPath: path.join(accountDir, "crypto-idb-snapshot.json"),
    recoveryKeyPath: path.join(accountDir, "recovery-key.json"),
    rootDir,
    storagePath: path.join(accountDir, "sync-store.json"),
  };
}

export async function prepareMatrixQaE2eeStorage(params: {
  actorId: MatrixQaE2eeActorId;
  outputDir: string;
  scenarioId: string;
}) {
  const storage = buildMatrixQaE2eeStoragePaths(params);
  await fs.mkdir(storage.rootDir, { mode: 0o700, recursive: true });
  await fs.mkdir(storage.accountDir, { mode: 0o700, recursive: true });
  await fs.chmod(storage.rootDir, 0o700);
  await fs.chmod(storage.accountDir, 0o700);
  return storage;
}
