import fs from "node:fs/promises";
import path from "node:path";
import { inheritMatrixQaReplacementRelation, type MatrixQaObservedEvent } from "./events.js";

export type MatrixQaE2eeActorId = "driver" | "observer" | `driver-${string}` | `cli-${string}`;

export const MATRIX_QA_E2EE_SYNC_FILTER = {
  room: {
    ephemeral: { not_types: ["m.receipt"] },
  },
};

export async function runMatrixQaE2eeClientOperation<T>(params: {
  label: string;
  run: () => Promise<T>;
  stop: () => void;
  timeoutMs: number;
}): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Matrix SDK encryption can wait indefinitely after room-key sharing. Stop this
      // disposable QA client so the scenario can fail and release its worker resources.
      try {
        params.stop();
      } catch {
        // Preserve the operation timeout as the actionable failure.
      }
      reject(new Error(`${params.label} timed out after ${params.timeoutMs}ms`));
    }, params.timeoutMs);
    timer.unref();
  });

  try {
    return await Promise.race([params.run(), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
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
