// Persists runtime tool-schema quarantines in the shared SQLite-backed core
// plugin-state store so health surfaces can see failures from any live
// runtime process.
import {
  createRuntimeHealthRecordEnvelope,
  createRuntimeHealthStore,
  type RuntimeHealthRecordEnvelope,
} from "../plugin-state/runtime-health-store.js";

type RuntimeToolSchemaQuarantine = {
  toolName: string;
  owner?: string;
  reason: string;
  failedAt: Date;
};

type PersistedRuntimeToolSchemaQuarantineRecord = RuntimeHealthRecordEnvelope & {
  toolName: string;
  owner?: string;
  reason: string;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const quarantineStore = createRuntimeHealthStore<PersistedRuntimeToolSchemaQuarantineRecord>({
  ownerId: "core:runtime-tool-quarantine-health",
  namespace: "schema-quarantines",
  maxEntries: 128,
  // Failing runs re-register their quarantine and refresh this TTL, so it only
  // expires records that stop recurring (e.g. a schema fixed without restart).
  ttlMs: 24 * 60 * 60 * 1_000,
  normalizeRecord: (value) => {
    if (!isNonEmptyString(value.toolName) || !isNonEmptyString(value.reason)) {
      return undefined;
    }
    return {
      toolName: value.toolName,
      reason: value.reason,
      failedAtMs: value.failedAtMs,
      processId: value.processId,
      processToken: value.processToken,
      processStartTime: value.processStartTime,
      ...(isNonEmptyString(value.owner) ? { owner: value.owner } : {}),
    };
  },
  displayKey: (record) => JSON.stringify([record.owner ?? "", record.toolName]),
  // Latest wins: the most recent violation message is the actionable one.
  pick: "latest",
});

function recordKey(
  record: Pick<PersistedRuntimeToolSchemaQuarantineRecord, "owner" | "toolName" | "processId">,
): string {
  return JSON.stringify([record.owner ?? "", record.toolName, record.processId]);
}

export type RuntimeToolSchemaQuarantineIdentity = {
  toolName: string;
  owner?: string;
};

function identityKey(identity: RuntimeToolSchemaQuarantineIdentity): string {
  return JSON.stringify([identity.owner ?? "", identity.toolName]);
}

// Keys this process has persisted. Recovery clearing checks this set first so
// the per-run path does zero store IO unless this process actually recorded a
// quarantine that may have recovered.
const locallyPersistedKeys = new Set<string>();

export function recordPersistedRuntimeToolSchemaQuarantine(
  quarantine: RuntimeToolSchemaQuarantine,
): void {
  const record: PersistedRuntimeToolSchemaQuarantineRecord = {
    toolName: quarantine.toolName,
    reason: quarantine.reason,
    ...createRuntimeHealthRecordEnvelope(quarantine.failedAt),
    ...(quarantine.owner ? { owner: quarantine.owner } : {}),
  };
  quarantineStore.register(recordKey(record), record);
  locallyPersistedKeys.add(identityKey(record));
}

/**
 * Removes this process's persisted quarantines for tools that now validate
 * cleanly. `listHealthyTools` is only invoked when this process has persisted
 * quarantines, keeping the common per-run path free of work.
 */
export function clearRecoveredPersistedRuntimeToolSchemaQuarantines(
  listHealthyTools: () => readonly RuntimeToolSchemaQuarantineIdentity[],
): void {
  if (locallyPersistedKeys.size === 0) {
    return;
  }
  const recoveredKeys = new Set(
    listHealthyTools()
      .map(identityKey)
      .filter((key) => locallyPersistedKeys.has(key)),
  );
  if (recoveredKeys.size === 0) {
    return;
  }
  quarantineStore.clearForProcess(process.pid, (record) => recoveredKeys.has(identityKey(record)));
  for (const key of recoveredKeys) {
    locallyPersistedKeys.delete(key);
  }
}

export function listPersistedRuntimeToolSchemaQuarantines(): RuntimeToolSchemaQuarantine[] {
  return quarantineStore.list().map((record) => {
    const quarantine: RuntimeToolSchemaQuarantine = {
      toolName: record.toolName,
      reason: record.reason,
      failedAt: new Date(record.failedAtMs),
    };
    if (record.owner) {
      quarantine.owner = record.owner;
    }
    return quarantine;
  });
}
