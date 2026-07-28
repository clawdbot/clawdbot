// Persists context-engine runtime quarantines so health surfaces can see
// failures recorded in sibling runtime processes.
import {
  createRuntimeHealthRecordEnvelope,
  createRuntimeHealthStore,
  type RuntimeHealthRecordEnvelope,
} from "../plugin-state/runtime-health-store.js";

type PersistedContextEngineRuntimeQuarantine = {
  engineId: string;
  owner?: string;
  operation: string;
  reason: string;
  failedAt: Date;
};

type PersistedContextEngineQuarantineRecord = RuntimeHealthRecordEnvelope & {
  engineId: string;
  owner?: string;
  operation: string;
  reason: string;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// No TTL: a quarantine is recorded once per failure and stays valid for the
// recorder's lifetime, so process liveness alone owns expiry here.
const quarantineStore = createRuntimeHealthStore<PersistedContextEngineQuarantineRecord>({
  ownerId: "core:context-engine-quarantine-health",
  namespace: "runtime-quarantines",
  maxEntries: 64,
  normalizeRecord: (value) => {
    if (
      !isNonEmptyString(value.engineId) ||
      !isNonEmptyString(value.operation) ||
      !isNonEmptyString(value.reason)
    ) {
      return undefined;
    }
    return {
      engineId: value.engineId,
      operation: value.operation,
      reason: value.reason,
      failedAtMs: value.failedAtMs,
      processId: value.processId,
      processToken: value.processToken,
      processStartTime: value.processStartTime,
      ...(isNonEmptyString(value.owner) ? { owner: value.owner } : {}),
    };
  },
  displayKey: (record) => record.engineId,
  // Earliest wins, matching the in-memory registry's first-failure-wins rule
  // so health output points at the root cause, not follow-on failures.
  pick: "earliest",
});

function recordKey(record: Pick<PersistedContextEngineQuarantineRecord, "engineId" | "processId">) {
  return JSON.stringify([record.engineId, record.processId]);
}

export function recordPersistedContextEngineQuarantine(
  quarantine: PersistedContextEngineRuntimeQuarantine,
): void {
  const record: PersistedContextEngineQuarantineRecord = {
    engineId: quarantine.engineId,
    operation: quarantine.operation,
    reason: quarantine.reason,
    ...createRuntimeHealthRecordEnvelope(quarantine.failedAt),
    ...(quarantine.owner ? { owner: quarantine.owner } : {}),
  };
  // The in-memory registry only records the first quarantine per engine, so
  // this is called at most once per (engine, process) and overwrite is safe.
  quarantineStore.register(recordKey(record), record);
}

export function listPersistedContextEngineQuarantines(): PersistedContextEngineRuntimeQuarantine[] {
  return quarantineStore.list().map((record) => {
    const quarantine: PersistedContextEngineRuntimeQuarantine = {
      engineId: record.engineId,
      operation: record.operation,
      reason: record.reason,
      failedAt: new Date(record.failedAtMs),
    };
    if (record.owner) {
      quarantine.owner = record.owner;
    }
    return quarantine;
  });
}

export function clearPersistedContextEngineQuarantineForProcess(
  engineId: string | undefined,
  processId: number,
): void {
  quarantineStore.clearForProcess(
    processId,
    engineId === undefined ? undefined : (record) => record.engineId === engineId,
  );
}
