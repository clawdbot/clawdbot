import { createHash } from "node:crypto";
import { resolveWorkspaceStateIdentity } from "../agents/workspace-state-store.js";
import {
  pluginStateEntriesInKeyRange,
  registerPluginStateSyncSequencedJournalEntry,
} from "../plugin-state/plugin-state-store.js";
import type { MemoryHostEventRecord } from "./event-types.js";

const MEMORY_HOST_EVENTS_PLUGIN_ID = "memory-core";
const MEMORY_HOST_EVENTS_NAMESPACE = "memory-host.events";
const MEMORY_HOST_EVENT_CURSORS_NAMESPACE = "memory-host.event-cursors";
// Event rotation retains deep diagnostics without consuming memory-core's
// plugin-wide 50,000-row budget or starving sibling state namespaces.
const MAX_MEMORY_HOST_EVENTS = 10_000;
const MAX_MEMORY_HOST_EVENT_CURSORS = 1_000;
const MAX_MEMORY_HOST_EVENT_JSON_BYTES = 8 * 1024;
const MAX_MEMORY_HOST_EVENT_ITEMS = 10;
const MAX_MEMORY_HOST_EVENT_TEXT_BYTES = 2 * 1024;
const MAX_MEMORY_HOST_EVENT_PATH_BYTES = 256;
const WORKSPACE_HASH_BYTES = 24;

type StoredMemoryHostEvent = {
  kind: "event";
  event: MemoryHostEventRecord;
  recordedAt: number;
  sequence: number;
};

let maxMemoryHostEventsForTests: number | undefined;

export type PersistedMemoryHostEvent = {
  key: string;
  value: StoredMemoryHostEvent;
  createdAt: number;
};

function normalizeMemoryHostWorkspaceKey(workspaceDir: string): string {
  // Workspace aliases must share one event/cursor namespace. Otherwise two
  // configured paths to the same workspace can publish conflicting exports.
  const resolved = resolveWorkspaceStateIdentity(workspaceDir).workspacePath.replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function memoryHostWorkspacePrefix(workspaceDir: string): string {
  return createHash("sha256")
    .update(normalizeMemoryHostWorkspaceKey(workspaceDir))
    .digest("hex")
    .slice(0, WORKSPACE_HASH_BYTES);
}

function eventKeyPrefix(workspaceDir: string): string {
  return `${memoryHostWorkspacePrefix(workspaceDir)}:event:`;
}

function eventKeyRangeEnd(workspaceDir: string): string {
  return `${memoryHostWorkspacePrefix(workspaceDir)}:event;`;
}

function memoryHostEventStorageKey(workspaceDir: string, sequence: number): string {
  if (!Number.isSafeInteger(sequence)) {
    throw new Error("Memory host event sequence must be a safe integer");
  }
  return `${eventKeyPrefix(workspaceDir)}1:${sequence.toString().padStart(16, "0")}`;
}

function cursorKey(workspaceDir: string): string {
  return `${memoryHostWorkspacePrefix(workspaceDir)}:cursor`;
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { value, truncated: false };
  }
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes - 3) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const end = low > 0 && /[\uD800-\uDBFF]/u.test(value.charAt(low - 1)) ? low - 1 : low;
  return { value: `${value.slice(0, end)}…`, truncated: true };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Validate and bound one diagnostic event before storing it in plugin state. */
export function normalizeMemoryHostEventRecordForStorage(
  value: unknown,
): MemoryHostEventRecord | null {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.timestamp !== "string") {
    return null;
  }
  const timestamp = truncateUtf8(value.timestamp, 128);
  let truncated = timestamp.truncated || value.storageTruncated === true;

  if (value.type === "memory.recall.recorded" || value.type === "memory.recall.skipped") {
    if (
      typeof value.query !== "string" ||
      !Array.isArray(value.results) ||
      (value.type === "memory.recall.recorded"
        ? !isFiniteNumber(value.resultCount)
        : !isFiniteNumber(value.skippedResultCount))
    ) {
      return null;
    }
    if (
      value.type === "memory.recall.skipped" &&
      (value.reason !== "non-short-term-memory-path" ||
        !isFiniteNumber(value.eligibleResultCount) ||
        !isFiniteNumber(value.skippedResultCount))
    ) {
      return null;
    }
    const query = truncateUtf8(value.query, MAX_MEMORY_HOST_EVENT_TEXT_BYTES);
    truncated ||= query.truncated || value.results.length > MAX_MEMORY_HOST_EVENT_ITEMS;
    const results: Array<{
      path: string;
      startLine: number;
      endLine: number;
      score: number;
      reason?: "non-short-term-memory-path";
    }> = [];
    for (const result of value.results.slice(0, MAX_MEMORY_HOST_EVENT_ITEMS)) {
      if (
        !isRecord(result) ||
        typeof result.path !== "string" ||
        !isFiniteNumber(result.startLine) ||
        !isFiniteNumber(result.endLine) ||
        !isFiniteNumber(result.score) ||
        (value.type === "memory.recall.skipped" && result.reason !== "non-short-term-memory-path")
      ) {
        return null;
      }
      const resultPath = truncateUtf8(result.path, MAX_MEMORY_HOST_EVENT_PATH_BYTES);
      truncated ||= resultPath.truncated;
      results.push({
        path: resultPath.value,
        startLine: result.startLine,
        endLine: result.endLine,
        score: result.score,
        ...(value.type === "memory.recall.skipped"
          ? { reason: "non-short-term-memory-path" as const }
          : {}),
      });
    }
    const normalized =
      value.type === "memory.recall.recorded"
        ? {
            type: "memory.recall.recorded" as const,
            timestamp: timestamp.value,
            query: query.value,
            resultCount: value.resultCount as number,
            results: results.map((result) => ({
              path: result.path,
              startLine: result.startLine,
              endLine: result.endLine,
              score: result.score,
            })),
            ...(truncated ? { storageTruncated: true as const } : {}),
          }
        : {
            type: "memory.recall.skipped" as const,
            timestamp: timestamp.value,
            query: query.value,
            reason: "non-short-term-memory-path" as const,
            eligibleResultCount: value.eligibleResultCount as number,
            skippedResultCount: value.skippedResultCount as number,
            results: results.map((result) => ({
              path: result.path,
              startLine: result.startLine,
              endLine: result.endLine,
              score: result.score,
              reason: "non-short-term-memory-path" as const,
            })),
            ...(truncated ? { storageTruncated: true as const } : {}),
          };
    return Buffer.byteLength(JSON.stringify(normalized), "utf8") <= MAX_MEMORY_HOST_EVENT_JSON_BYTES
      ? normalized
      : { ...normalized, results: [], storageTruncated: true as const };
  }

  if (value.type === "memory.promotion.applied") {
    if (
      typeof value.memoryPath !== "string" ||
      !isFiniteNumber(value.applied) ||
      !Array.isArray(value.candidates)
    ) {
      return null;
    }
    const memoryPath = truncateUtf8(value.memoryPath, MAX_MEMORY_HOST_EVENT_PATH_BYTES);
    truncated ||= memoryPath.truncated || value.candidates.length > MAX_MEMORY_HOST_EVENT_ITEMS;
    const candidates: Array<{
      key: string;
      path: string;
      startLine: number;
      endLine: number;
      score: number;
      recallCount: number;
    }> = [];
    for (const candidate of value.candidates.slice(0, MAX_MEMORY_HOST_EVENT_ITEMS)) {
      if (
        !isRecord(candidate) ||
        typeof candidate.key !== "string" ||
        typeof candidate.path !== "string" ||
        !isFiniteNumber(candidate.startLine) ||
        !isFiniteNumber(candidate.endLine) ||
        !isFiniteNumber(candidate.score) ||
        !isFiniteNumber(candidate.recallCount)
      ) {
        return null;
      }
      const key = truncateUtf8(candidate.key, MAX_MEMORY_HOST_EVENT_PATH_BYTES);
      const candidatePath = truncateUtf8(candidate.path, MAX_MEMORY_HOST_EVENT_PATH_BYTES);
      truncated ||= key.truncated || candidatePath.truncated;
      candidates.push({
        key: key.value,
        path: candidatePath.value,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        score: candidate.score,
        recallCount: candidate.recallCount,
      });
    }
    const normalized = {
      type: "memory.promotion.applied" as const,
      timestamp: timestamp.value,
      memoryPath: memoryPath.value,
      applied: value.applied,
      candidates,
      ...(truncated ? { storageTruncated: true as const } : {}),
    };
    return Buffer.byteLength(JSON.stringify(normalized), "utf8") <= MAX_MEMORY_HOST_EVENT_JSON_BYTES
      ? normalized
      : { ...normalized, candidates: [], storageTruncated: true as const };
  }

  if (value.type === "memory.dream.completed") {
    if (
      (value.phase !== "light" && value.phase !== "deep" && value.phase !== "rem") ||
      (value.outcome !== undefined &&
        value.outcome !== "completed" &&
        value.outcome !== "failed") ||
      (value.error !== undefined && typeof value.error !== "string") ||
      (value.inlinePath !== undefined && typeof value.inlinePath !== "string") ||
      (value.reportPath !== undefined && typeof value.reportPath !== "string") ||
      !isFiniteNumber(value.lineCount) ||
      (value.storageMode !== "inline" &&
        value.storageMode !== "separate" &&
        value.storageMode !== "both")
    ) {
      return null;
    }
    const error = value.error
      ? truncateUtf8(value.error, MAX_MEMORY_HOST_EVENT_TEXT_BYTES)
      : undefined;
    const inlinePath = value.inlinePath
      ? truncateUtf8(value.inlinePath, MAX_MEMORY_HOST_EVENT_PATH_BYTES)
      : undefined;
    const reportPath = value.reportPath
      ? truncateUtf8(value.reportPath, MAX_MEMORY_HOST_EVENT_PATH_BYTES)
      : undefined;
    truncated ||= Boolean(error?.truncated || inlinePath?.truncated || reportPath?.truncated);
    return {
      type: value.type,
      timestamp: timestamp.value,
      phase: value.phase,
      ...(value.outcome ? { outcome: value.outcome } : {}),
      ...(error ? { error: error.value } : {}),
      ...(inlinePath ? { inlinePath: inlinePath.value } : {}),
      ...(reportPath ? { reportPath: reportPath.value } : {}),
      lineCount: value.lineCount,
      storageMode: value.storageMode,
      ...(truncated ? { storageTruncated: true } : {}),
    };
  }

  return null;
}

export function registerMemoryHostEvent(params: {
  workspaceDir: string;
  event: MemoryHostEventRecord;
  env?: NodeJS.ProcessEnv;
}): void {
  const event = normalizeMemoryHostEventRecordForStorage(params.event);
  if (!event) {
    throw new TypeError("Memory host event is invalid");
  }
  const initialSequence = Math.max(
    0,
    listStoredMemoryHostEvents({
      workspaceDir: params.workspaceDir,
      limit: 1,
      ...(params.env ? { env: params.env } : {}),
    }).at(-1)?.value.sequence ?? 0,
  );
  const recordedAt = Date.now();
  registerPluginStateSyncSequencedJournalEntry({
    pluginId: MEMORY_HOST_EVENTS_PLUGIN_ID,
    cursorOptions: {
      namespace: MEMORY_HOST_EVENT_CURSORS_NAMESPACE,
      maxEntries: MAX_MEMORY_HOST_EVENT_CURSORS,
      ...(params.env ? { env: params.env } : {}),
    },
    cursorKey: cursorKey(params.workspaceDir),
    journalOptions: {
      namespace: MEMORY_HOST_EVENTS_NAMESPACE,
      maxEntries: maxMemoryHostEventsForTests ?? MAX_MEMORY_HOST_EVENTS,
      ...(params.env ? { env: params.env } : {}),
    },
    initialSequence,
    journalKey: (sequence) => memoryHostEventStorageKey(params.workspaceDir, sequence),
    journalValue: (sequence) => ({ kind: "event", event, recordedAt, sequence }),
  });
}

export function listStoredMemoryHostEvents(params: {
  workspaceDir: string;
  limit?: number;
  env?: NodeJS.ProcessEnv;
}): PersistedMemoryHostEvent[] {
  const limit = Number.isFinite(params.limit)
    ? Math.max(
        1,
        Math.min(
          maxMemoryHostEventsForTests ?? MAX_MEMORY_HOST_EVENTS,
          Math.floor(params.limit as number),
        ),
      )
    : (maxMemoryHostEventsForTests ?? MAX_MEMORY_HOST_EVENTS);
  const entries = pluginStateEntriesInKeyRange({
    pluginId: MEMORY_HOST_EVENTS_PLUGIN_ID,
    namespace: MEMORY_HOST_EVENTS_NAMESPACE,
    keyStartInclusive: eventKeyPrefix(params.workspaceDir),
    keyEndExclusive: eventKeyRangeEnd(params.workspaceDir),
    limit,
    order: "desc",
    ...(params.env ? { env: params.env } : {}),
  }).flatMap((entry): PersistedMemoryHostEvent[] => {
    const value = entry.value as StoredMemoryHostEvent;
    return value.kind === "event" ? [{ ...entry, value }] : [];
  });
  return entries.toReversed();
}

/** Test-only retention override; production keeps a 10,000-event namespace budget. */
export function setMaxMemoryHostEventsForTests(maxEntries?: number): void {
  maxMemoryHostEventsForTests = maxEntries;
}
