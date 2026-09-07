// Persists context-engine runtime quarantines so health surfaces can see
// failures recorded in sibling runtime processes.
import { hasNonEmptyString } from "@openclaw/normalization-core/string-coerce";
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

type PersistedContextEngineQuarantineRecord = RuntimeHealthRecordEnvelope &
  Omit<PersistedContextEngineRuntimeQuarantine, "failedAt">;

// No TTL: a quarantine is recorded once per failure and stays valid for the
// recorder's lifetime, so process liveness alone owns expiry here.
const quarantineStore = createRuntimeHealthStore<PersistedContextEngineQuarantineRecord>({
  ownerId: "core:context-engine-quarantine-health",
  namespace: "runtime-quarantines",
  maxEntries: 64,
  normalizeRecord: (value) => {
    if (
      !hasNonEmptyString(value.engineId) ||
      !hasNonEmptyString(value.operation) ||
      !hasNonEmptyString(value.reason)
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
      ...(hasNonEmptyString(value.owner) ? { owner: value.owner } : {}),
    };
  },
  displayKey: (record) => record.engineId,
  // Earliest wins, matching the in-memory registry's first-failure-wins rule
  // so health output points at the root cause, not follow-on failures.
  pick: "earliest",
});

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
  quarantineStore.register(JSON.stringify([record.engineId, record.processId]), record);
}

export function listPersistedContextEngineQuarantines(): PersistedContextEngineRuntimeQuarantine[] {
  return quarantineStore.list().map(({ engineId, operation, reason, owner, failedAtMs }) => {
    const quarantine: PersistedContextEngineRuntimeQuarantine = {
      engineId,
      operation,
      reason,
      failedAt: new Date(failedAtMs),
    };
    if (owner) {
      quarantine.owner = owner;
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
