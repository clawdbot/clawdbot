import crypto from "node:crypto";
import path from "node:path";
import {
  normalizeMemoryHostEventRecordForStorage,
  resolveMemoryHostEventLogPath,
} from "openclaw/plugin-sdk/memory-host-events";
import type {
  PluginDoctorStateMigration,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor";
import {
  collectLegacyMemoryHostEventSources,
  memoryHostWorkspacePrefix,
  resolveMemoryHostEventArchivePath,
  type LegacyMemoryHostEventSource,
  type ReadyLegacyMemoryHostEventSource,
} from "./doctor-host-event-sources.js";

type StoredMemoryHostEvent = {
  kind: "event";
  event: NonNullable<ReturnType<typeof normalizeMemoryHostEventRecordForStorage>>;
  recordedAt: number;
  sequence: number;
};

type StoredMemoryHostCursor = {
  kind: "cursor";
  lastSequence: number;
};

type StoredMemoryHostMigrationCheckpoint = {
  kind: "migration-checkpoint";
  contentHash: string;
  recordCount: number;
  sequenceBase: number;
  size: number;
};

const MEMORY_HOST_EVENTS_NAMESPACE = "memory-host.events";
const MEMORY_HOST_EVENT_CURSORS_NAMESPACE = "memory-host.event-cursors";
const MEMORY_HOST_EVENT_MIGRATION_CHECKPOINTS_NAMESPACE = "memory-host.event-migration-checkpoints";
// Keep migration aligned with event-store.ts retention so legacy import cannot
// consume memory-core's plugin-wide budget or starve sibling state namespaces.
const MAX_MEMORY_HOST_EVENTS = 10_000;
const MAX_MEMORY_HOST_EVENT_CURSORS = 1_000;
const MAX_MEMORY_HOST_EVENT_MIGRATION_CHECKPOINTS = 10_000;
const MAX_LEGACY_MEMORY_HOST_EVENT_VALUE_BYTES = 65_536;
const LEGACY_MEMORY_HOST_SEQUENCE_BASE = Number.MIN_SAFE_INTEGER;

function memoryHostMigrationCheckpointKey(source: ReadyLegacyMemoryHostEventSource): string {
  if (!source.generationKey) {
    throw new Error(`Missing Memory Core host event archive generation for ${source.filePath}`);
  }
  return `${memoryHostWorkspacePrefix(source.workspaceDir)}:archive:${source.generationKey}`;
}

function memoryHostMigrationSnapshot(raw: string, recordCount: number, sequenceBase: number) {
  return {
    kind: "migration-checkpoint" as const,
    contentHash: crypto.createHash("sha256").update(raw).digest("hex"),
    recordCount,
    sequenceBase,
    size: Buffer.byteLength(raw, "utf8"),
  };
}

function isMemoryHostMigrationCheckpoint(
  value: StoredMemoryHostMigrationCheckpoint | undefined,
): value is StoredMemoryHostMigrationCheckpoint {
  return (
    value?.kind === "migration-checkpoint" &&
    typeof value.contentHash === "string" &&
    Number.isSafeInteger(value.recordCount) &&
    value.recordCount >= 0 &&
    Number.isSafeInteger(value.sequenceBase) &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0
  );
}

async function memoryHostEventSourceNeedsMigration(params: {
  source: ReadyLegacyMemoryHostEventSource;
  context: PluginDoctorStateMigrationContext;
}): Promise<boolean> {
  if (params.source.storage !== "archive") {
    return true;
  }
  const checkpoint = await params.context
    .openPluginStateKeyedStore<StoredMemoryHostMigrationCheckpoint>({
      namespace: MEMORY_HOST_EVENT_MIGRATION_CHECKPOINTS_NAMESPACE,
      maxEntries: MAX_MEMORY_HOST_EVENT_MIGRATION_CHECKPOINTS,
      overflowPolicy: "reject-new",
    })
    .lookup(memoryHostMigrationCheckpointKey(params.source));
  if (!isMemoryHostMigrationCheckpoint(checkpoint)) {
    return true;
  }
  const raw = await params.source.root.readText(params.source.relativePath);
  return (
    Buffer.byteLength(raw, "utf8") !== checkpoint.size ||
    crypto.createHash("sha256").update(raw).digest("hex") !== checkpoint.contentHash
  );
}

async function finalizeLegacyMemoryHostEventSource(params: {
  source: ReadyLegacyMemoryHostEventSource;
  changes: string[];
  warnings: string[];
}): Promise<boolean> {
  if (params.source.storage === "archive") {
    return true;
  }
  const archivedRelativePath = params.source.archiveRelativePath;
  if (!archivedRelativePath) {
    throw new Error(`Missing Memory Core host event archive path for ${params.source.filePath}`);
  }
  try {
    await params.source.root.move(params.source.relativePath, archivedRelativePath);
    params.changes.push(
      `Archived Memory Core host events legacy source -> ${path.join(params.source.workspaceDir, archivedRelativePath)}`,
    );
    return true;
  } catch (error) {
    params.warnings.push(
      `Failed archiving Memory Core host events legacy source: ${String(error)}`,
    );
    return false;
  }
}

async function restoreClaimedMemoryHostEventSource(params: {
  source: ReadyLegacyMemoryHostEventSource;
  activeRelativePath: string;
  warnings: string[];
}): Promise<void> {
  try {
    if (!(await params.source.root.exists(params.source.relativePath))) {
      return;
    }
    if (!(await params.source.root.exists(params.activeRelativePath))) {
      await params.source.root.move(params.source.relativePath, params.activeRelativePath);
      return;
    }
    params.warnings.push(
      `Left claimed Memory Core host events at ${params.source.filePath} because an old writer recreated the active source`,
    );
  } catch (error) {
    params.warnings.push(
      `Failed restoring claimed Memory Core host events ${params.source.filePath}: ${String(error)}`,
    );
  }
}

async function migrateLegacyMemoryHostEventSource(params: {
  source: ReadyLegacyMemoryHostEventSource;
  context: PluginDoctorStateMigrationContext;
  changes: string[];
  warnings: string[];
}): Promise<"completed" | "blocked"> {
  const activeRelativePath = path.relative(
    params.source.workspaceDir,
    resolveMemoryHostEventLogPath(params.source.workspaceDir),
  );
  let source = params.source;
  let restoreNewClaim = false;
  let claimFinalized = source.storage === "archive";
  if (source.storage === "active") {
    const generation = await resolveMemoryHostEventArchivePath(source);
    await source.root.move(source.relativePath, generation.claimRelativePath);
    source = {
      ...source,
      filePath: path.join(source.workspaceDir, generation.claimRelativePath),
      relativePath: generation.claimRelativePath,
      storage: "claim",
      archiveRelativePath: generation.archiveRelativePath,
      generationKey: generation.generationKey,
    };
    restoreNewClaim = true;
  }

  try {
    if (!source.generationKey) {
      throw new Error(`Missing Memory Core host event generation for ${source.filePath}`);
    }
    const warningStart = params.warnings.length;
    const raw = await source.root.readText(source.relativePath);
    const prefix = memoryHostWorkspacePrefix(source.workspaceDir);
    const records: Array<{
      digest: string;
      ordinal: number;
      value: StoredMemoryHostEvent;
    }> = [];
    for (const [lineIndex, line] of raw.split(/\r?\n/u).entries()) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let event: unknown;
      try {
        event = JSON.parse(trimmed) as unknown;
      } catch (error) {
        params.warnings.push(
          `Skipped malformed Memory Core host event at ${source.filePath}:${lineIndex + 1}: ${String(error)}`,
        );
        continue;
      }
      const normalizedEvent = normalizeMemoryHostEventRecordForStorage(event);
      if (!normalizedEvent) {
        params.warnings.push(
          `Skipped invalid Memory Core host event at ${source.filePath}:${lineIndex + 1}`,
        );
        continue;
      }
      const canonicalEvent = JSON.stringify(normalizedEvent);
      const parsedTimestamp = Date.parse(normalizedEvent.timestamp);
      const recordedAt = Number.isSafeInteger(parsedTimestamp) ? parsedTimestamp : 0;
      const ordinal = records.length;
      const digest = crypto.createHash("sha256").update(canonicalEvent).digest("hex");
      const value: StoredMemoryHostEvent = {
        kind: "event",
        event: normalizedEvent,
        recordedAt,
        sequence: LEGACY_MEMORY_HOST_SEQUENCE_BASE + ordinal + 1,
      };
      if (
        Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_LEGACY_MEMORY_HOST_EVENT_VALUE_BYTES
      ) {
        params.warnings.push(
          `Skipped oversized Memory Core host event at ${source.filePath}:${lineIndex + 1}`,
        );
        continue;
      }
      records.push({
        // Runtime keys use the adjacent `1:` range. Generation plus valid-row
        // ordinal makes interrupted imports and later raw-archive recovery stable.
        digest,
        ordinal,
        value,
      });
    }
    if (params.warnings.length > warningStart) {
      params.warnings.push(
        "Left Memory Core host events legacy source in place because invalid rows still require repair",
      );
      return "blocked";
    }

    const checkpointStore =
      params.context.openPluginStateKeyedStore<StoredMemoryHostMigrationCheckpoint>({
        namespace: MEMORY_HOST_EVENT_MIGRATION_CHECKPOINTS_NAMESPACE,
        maxEntries: MAX_MEMORY_HOST_EVENT_MIGRATION_CHECKPOINTS,
        overflowPolicy: "reject-new",
      });
    // Plugin-wide shedding is namespace-local. `reject-new` therefore keeps
    // retained raw-archive checkpoints out of every sibling namespace's
    // eviction budget and fails before this namespace can rotate its own rows.
    const checkpointKey = memoryHostMigrationCheckpointKey(source);
    const checkpointValue = await checkpointStore.lookup(checkpointKey);
    const previousCheckpoint = isMemoryHostMigrationCheckpoint(checkpointValue)
      ? checkpointValue
      : undefined;
    if (source.storage === "archive" && previousCheckpoint) {
      const bytes = Buffer.from(raw, "utf8");
      const prefixHash = crypto
        .createHash("sha256")
        .update(bytes.subarray(0, previousCheckpoint.size))
        .digest("hex");
      if (
        bytes.length < previousCheckpoint.size ||
        prefixHash !== previousCheckpoint.contentHash ||
        records.length < previousCheckpoint.recordCount
      ) {
        params.warnings.push(
          `Skipped Memory Core host event recovery because ${source.filePath} changed other than by append; left the archive in place`,
        );
        return "blocked";
      }
    }
    const firstCandidateOrdinal =
      source.storage === "archive" && previousCheckpoint ? previousCheckpoint.recordCount : 0;
    const candidateRecords = records.slice(firstCandidateOrdinal);
    const store = params.context.openPluginStateKeyedStore<StoredMemoryHostEvent>({
      namespace: MEMORY_HOST_EVENTS_NAMESPACE,
      maxEntries: MAX_MEMORY_HOST_EVENTS,
    });
    const existingEntries = await store.entries();
    const existingKeys = new Set(existingEntries.map((entry) => entry.key));
    const latestLegacySequence = existingEntries.reduce(
      (latest, entry) =>
        entry.value.sequence < 0 ? Math.max(latest, entry.value.sequence) : latest,
      LEGACY_MEMORY_HOST_SEQUENCE_BASE,
    );
    const legacyKeyPrefix = `${prefix}:event:0:s:`;
    const existingByIdentity = new Map<string, (typeof existingEntries)[number]>(
      existingEntries.flatMap((entry) => {
        if (!entry.key.startsWith(legacyKeyPrefix) || entry.value.sequence >= 0) {
          return [];
        }
        const parts = entry.key.split(":");
        return parts.length === 8 ? [[`${parts[5]}:${parts[6]}:${parts[7]}`, entry] as const] : [];
      }),
    );
    const existingSourceBase = candidateRecords.flatMap((record) => {
      const identity = `${source.generationKey}:${record.ordinal.toString().padStart(16, "0")}:${record.digest}`;
      const existing = existingByIdentity.get(identity);
      return existing ? [existing.value.sequence - (record.ordinal + 1)] : [];
    })[0];
    const laterGenerationExists = existingEntries.some((entry) => {
      if (!entry.key.startsWith(legacyKeyPrefix) || entry.value.sequence >= 0) {
        return false;
      }
      const generationKey = entry.key.split(":")[5];
      return generationKey !== undefined && generationKey > source.generationKey!;
    });
    if (
      source.storage === "archive" &&
      !previousCheckpoint &&
      existingSourceBase === undefined &&
      laterGenerationExists
    ) {
      params.warnings.push(
        `Skipped Memory Core host event recovery because ${source.filePath} has no durable checkpoint and later generations are already imported; left the archive in place`,
      );
      return "blocked";
    }
    const sourceSequenceBase =
      previousCheckpoint?.sequenceBase ?? existingSourceBase ?? latestLegacySequence;
    let nextSequence = latestLegacySequence;
    const sequencedRecords = candidateRecords.map((record) => {
      const ordinalKey = record.ordinal.toString().padStart(16, "0");
      const identity = `${source.generationKey}:${ordinalKey}:${record.digest}`;
      const existing = existingByIdentity.get(identity);
      if (existing) {
        return {
          ...record,
          key: existing.key,
          value: { ...record.value, sequence: existing.value.sequence },
        };
      }
      const sequence = previousCheckpoint
        ? (nextSequence += 1)
        : sourceSequenceBase + record.ordinal + 1;
      const sequenceKey = (sequence - LEGACY_MEMORY_HOST_SEQUENCE_BASE)
        .toString()
        .padStart(16, "0");
      return {
        ...record,
        key: `${legacyKeyPrefix}${sequenceKey}:${identity}`,
        value: { ...record.value, sequence },
      };
    });
    const sourceKeys = new Set(sequencedRecords.map((record) => record.key));
    if (
      sequencedRecords.some(
        (record) => !Number.isSafeInteger(record.value.sequence) || record.value.sequence >= 0,
      )
    ) {
      params.warnings.push(
        "Skipped Memory Core host event migration because legacy sequence capacity is exhausted; left legacy source in place",
      );
      return "blocked";
    }
    const nativeCount = existingEntries.filter((entry) => entry.value.sequence >= 0).length;
    const legacyRetentionLimit = Math.max(0, MAX_MEMORY_HOST_EVENTS - nativeCount);
    const combinedLegacy = [
      ...existingEntries
        .filter((entry) => entry.value.sequence < 0 && !sourceKeys.has(entry.key))
        .map((entry) => ({ key: entry.key, sequence: entry.value.sequence })),
      ...sequencedRecords.map((record) => ({
        key: record.key,
        sequence: record.value.sequence,
      })),
    ].toSorted(
      (left, right) => left.sequence - right.sequence || left.key.localeCompare(right.key),
    );
    const desiredLegacyKeys = new Set(
      legacyRetentionLimit === 0
        ? []
        : combinedLegacy.slice(-legacyRetentionLimit).map((record) => record.key),
    );
    let retainedRecords = sequencedRecords.filter((record) => desiredLegacyKeys.has(record.key));
    const capacity = params.context.getPluginStateCapacity?.();
    if (!capacity) {
      params.warnings.push(
        "Skipped Memory Core host event migration because plugin-wide SQLite capacity is unavailable; left legacy source in place",
      );
      return "blocked";
    }
    const pluginRemainingCapacity = Math.max(0, capacity.maxEntries - capacity.liveEntries);
    const cursorStore = params.context.openPluginStateKeyedStore<StoredMemoryHostCursor>({
      namespace: MEMORY_HOST_EVENT_CURSORS_NAMESPACE,
      maxEntries: MAX_MEMORY_HOST_EVENT_CURSORS,
    });
    const cursorKey = `${prefix}:cursor`;
    const existingCursor = await cursorStore.lookup(cursorKey);
    const cursorCapacity = candidateRecords.length > 0 && existingCursor?.kind !== "cursor" ? 1 : 0;
    if (cursorCapacity > pluginRemainingCapacity) {
      params.warnings.push(
        "Skipped Memory Core host event migration because SQLite plugin state has no room for its workspace cursor; left legacy source in place",
      );
      return "blocked";
    }
    const checkpointCapacity = checkpointValue ? 0 : 1;
    if (
      checkpointCapacity > 0 &&
      (await checkpointStore.entries()).length >= MAX_MEMORY_HOST_EVENT_MIGRATION_CHECKPOINTS
    ) {
      // Checkpoints use reject-new and never expire while their raw archives remain.
      // Stop before import/archive once durable processed-generation capacity is full.
      params.warnings.push(
        "Skipped Memory Core host event migration because durable raw-archive checkpoint capacity is exhausted; left legacy source in place",
      );
      return "blocked";
    }
    if (cursorCapacity + checkpointCapacity > pluginRemainingCapacity) {
      params.warnings.push(
        "Skipped Memory Core host event migration because SQLite plugin state has no room for its raw-archive checkpoint; left legacy source in place",
      );
      return "blocked";
    }
    const importEntries = params.context.importPluginStateEntries;
    if (candidateRecords.length > 0 && !importEntries) {
      params.warnings.push(
        "Skipped Memory Core host event migration because retention-aware SQLite import is unavailable; left legacy source in place",
      );
      return "blocked";
    }
    let retainedKeys = new Set(retainedRecords.map((record) => record.key));
    let missing = retainedRecords.filter((record) => !existingKeys.has(record.key));
    let replaceableLegacyRows = existingEntries.filter(
      (entry) => entry.value.sequence < 0 && !retainedKeys.has(entry.key),
    ).length;
    const reservedCapacity = cursorCapacity + checkpointCapacity;
    const eventCapacity = pluginRemainingCapacity - reservedCapacity + replaceableLegacyRows;
    const retentionDeficit = Math.max(0, missing.length - eventCapacity);
    if (retentionDeficit > 0) {
      retainedRecords = retainedRecords.slice(Math.min(retentionDeficit, retainedRecords.length));
      retainedKeys = new Set(retainedRecords.map((record) => record.key));
      missing = retainedRecords.filter((record) => !existingKeys.has(record.key));
      replaceableLegacyRows = existingEntries.filter(
        (entry) => entry.value.sequence < 0 && !retainedKeys.has(entry.key),
      ).length;
    }
    const availableEventCapacity =
      pluginRemainingCapacity - reservedCapacity + replaceableLegacyRows;
    if (missing.length > availableEventCapacity) {
      params.warnings.push(
        `Skipped Memory Core host event migration because SQLite plugin state has room for ${availableEventCapacity} of ${missing.length} missing rows after reserving its cursor and raw-archive checkpoint; left legacy source in place`,
      );
      return "blocked";
    }
    if (cursorCapacity > 0) {
      const lastSequence = existingEntries.reduce(
        (maximum, entry) =>
          Number.isSafeInteger(entry.value.sequence)
            ? Math.max(maximum, entry.value.sequence)
            : maximum,
        0,
      );
      await cursorStore.register(cursorKey, { kind: "cursor", lastSequence });
      const registeredCursor = await cursorStore.lookup(cursorKey);
      if (registeredCursor?.kind !== "cursor") {
        params.warnings.push(
          "Skipped Memory Core host event migration because its workspace cursor could not be verified; left legacy source in place",
        );
        return "blocked";
      }
    }
    importEntries?.(
      { namespace: MEMORY_HOST_EVENTS_NAMESPACE, maxEntries: MAX_MEMORY_HOST_EVENTS },
      missing.map((record) => ({
        key: record.key,
        value: record.value,
        // Negative legacy sequence keeps imported rows older than live runtime rows.
        createdAt: record.value.sequence,
      })),
    );
    const importedKeys = new Set((await store.entries()).map((entry) => entry.key));
    const missingKey = retainedRecords.find((record) => !importedKeys.has(record.key))?.key;
    if (missingKey) {
      params.warnings.push(
        `Skipped archiving Memory Core host events because SQLite verification missed ${missingKey}`,
      );
      return "blocked";
    }

    if (source.storage === "archive") {
      if (missing.length > 0) {
        params.changes.push(
          `Recovered ${missing.length} later Memory Core host event row(s) from ${source.filePath}`,
        );
      }
    } else {
      params.changes.push(
        records.length === 0
          ? "Retired empty Memory Core host events legacy source"
          : `Migrated Memory Core host events -> SQLite plugin state (${missing.length} new row(s))`,
      );
      claimFinalized = await finalizeLegacyMemoryHostEventSource({
        source,
        changes: params.changes,
        warnings: params.warnings,
      });
      if (!claimFinalized) {
        params.changes.pop();
        return "blocked";
      }
    }
    const checkpoint = memoryHostMigrationSnapshot(raw, records.length, sourceSequenceBase);
    await checkpointStore.register(checkpointKey, checkpoint);
    const registeredCheckpoint = await checkpointStore.lookup(checkpointKey);
    if (
      !isMemoryHostMigrationCheckpoint(registeredCheckpoint) ||
      registeredCheckpoint.contentHash !== checkpoint.contentHash ||
      registeredCheckpoint.recordCount !== checkpoint.recordCount ||
      registeredCheckpoint.sequenceBase !== checkpoint.sequenceBase ||
      registeredCheckpoint.size !== checkpoint.size
    ) {
      params.warnings.push(
        `Failed verifying Memory Core host event raw-archive checkpoint for ${source.filePath}`,
      );
      return "blocked";
    }
    if (source.storage !== "archive" && (await source.root.exists(activeRelativePath))) {
      params.warnings.push(
        "An old writer recreated the Memory Core host event source; rerun openclaw doctor --fix to import the retained rows",
      );
    }
    return "completed";
  } finally {
    if (restoreNewClaim && !claimFinalized) {
      await restoreClaimedMemoryHostEventSource({
        source,
        activeRelativePath,
        warnings: params.warnings,
      });
    }
  }
}

export const hostEventsStateMigration: PluginDoctorStateMigration = {
  id: "memory-core-host-events-jsonl-to-sqlite",
  label: "Memory Core host events",
  doctorOnly: true,
  async detectLegacyState(params) {
    const sources = await collectLegacyMemoryHostEventSources(params.config, params.env);
    const pending: LegacyMemoryHostEventSource[] = [];
    for (const source of sources) {
      if (
        source.kind === "rejected" ||
        (await memoryHostEventSourceNeedsMigration({ source, context: params.context }))
      ) {
        pending.push(source);
      }
    }
    if (pending.length === 0) {
      return null;
    }
    return {
      preview: pending.map((source) =>
        source.kind === "ready"
          ? `- Memory Core host events: ${source.filePath} -> SQLite plugin state (${MEMORY_HOST_EVENTS_NAMESPACE})`
          : `- Memory Core host events: ${source.filePath} requires safe-path repair (${source.reason})`,
      ),
    };
  },
  async migrateLegacyState(params) {
    const changes: string[] = [];
    const warnings: string[] = [];
    const blockedWorkspaces = new Set<string>();
    for (const source of await collectLegacyMemoryHostEventSources(params.config, params.env)) {
      if (blockedWorkspaces.has(source.workspaceDir)) {
        continue;
      }
      if (source.kind === "rejected") {
        warnings.push(
          `Skipped unsafe Memory Core host event source for ${source.workspaceDir}: ${source.reason}`,
        );
        blockedWorkspaces.add(source.workspaceDir);
        continue;
      }
      if (!(await memoryHostEventSourceNeedsMigration({ source, context: params.context }))) {
        continue;
      }
      const result = await migrateLegacyMemoryHostEventSource({
        source,
        context: params.context,
        changes,
        warnings,
      });
      if (result === "blocked") {
        // Archive generations encode append order. A later generation cannot
        // overtake an older source that still needs repair or durable import.
        blockedWorkspaces.add(source.workspaceDir);
      }
    }
    return { changes, warnings };
  },
};
