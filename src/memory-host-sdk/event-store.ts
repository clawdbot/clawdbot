import { createHash } from "node:crypto";
import { z } from "zod";
import { resolveWorkspaceStateIdentity } from "../agents/workspace-state-identity.js";
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

const memoryHostFiniteNumberSchema = z.number().finite();
const memoryHostRecallResultSchema = z.looseObject({
  path: z.string(),
  startLine: memoryHostFiniteNumberSchema,
  endLine: memoryHostFiniteNumberSchema,
  score: memoryHostFiniteNumberSchema,
});
const memoryHostSkippedRecallResultSchema = memoryHostRecallResultSchema.extend({
  reason: z.literal("non-short-term-memory-path"),
});
const boundedRecallResultsSchema = z.array(z.unknown()).transform((values, context) => {
  const parsed = z
    .array(memoryHostRecallResultSchema)
    .safeParse(values.slice(0, MAX_MEMORY_HOST_EVENT_ITEMS));
  if (!parsed.success) {
    context.addIssue({ code: "custom", message: "invalid recall result" });
    return z.NEVER;
  }
  return { items: parsed.data, truncated: values.length > MAX_MEMORY_HOST_EVENT_ITEMS };
});
const boundedSkippedRecallResultsSchema = z.array(z.unknown()).transform((values, context) => {
  const parsed = z
    .array(memoryHostSkippedRecallResultSchema)
    .safeParse(values.slice(0, MAX_MEMORY_HOST_EVENT_ITEMS));
  if (!parsed.success) {
    context.addIssue({ code: "custom", message: "invalid skipped recall result" });
    return z.NEVER;
  }
  return { items: parsed.data, truncated: values.length > MAX_MEMORY_HOST_EVENT_ITEMS };
});
const memoryHostPromotionCandidateSchema = z.looseObject({
  key: z.string(),
  path: z.string(),
  startLine: memoryHostFiniteNumberSchema,
  endLine: memoryHostFiniteNumberSchema,
  score: memoryHostFiniteNumberSchema,
  recallCount: memoryHostFiniteNumberSchema,
});
const boundedPromotionCandidatesSchema = z.array(z.unknown()).transform((values, context) => {
  const parsed = z
    .array(memoryHostPromotionCandidateSchema)
    .safeParse(values.slice(0, MAX_MEMORY_HOST_EVENT_ITEMS));
  if (!parsed.success) {
    context.addIssue({ code: "custom", message: "invalid promotion candidate" });
    return z.NEVER;
  }
  return { items: parsed.data, truncated: values.length > MAX_MEMORY_HOST_EVENT_ITEMS };
});
const memoryHostEventRecordSchema = z.discriminatedUnion("type", [
  z.looseObject({
    type: z.literal("memory.recall.recorded"),
    timestamp: z.string(),
    storageTruncated: z.unknown().optional(),
    query: z.string(),
    resultCount: memoryHostFiniteNumberSchema,
    results: boundedRecallResultsSchema,
  }),
  z.looseObject({
    type: z.literal("memory.recall.skipped"),
    timestamp: z.string(),
    storageTruncated: z.unknown().optional(),
    query: z.string(),
    reason: z.literal("non-short-term-memory-path"),
    eligibleResultCount: memoryHostFiniteNumberSchema,
    skippedResultCount: memoryHostFiniteNumberSchema,
    results: boundedSkippedRecallResultsSchema,
  }),
  z.looseObject({
    type: z.literal("memory.promotion.applied"),
    timestamp: z.string(),
    storageTruncated: z.unknown().optional(),
    memoryPath: z.string(),
    applied: memoryHostFiniteNumberSchema,
    candidates: boundedPromotionCandidatesSchema,
  }),
  z.looseObject({
    type: z.literal("memory.dream.completed"),
    timestamp: z.string(),
    storageTruncated: z.unknown().optional(),
    phase: z.enum(["light", "deep", "rem"]),
    outcome: z.enum(["completed", "failed"]).optional(),
    error: z.string().optional(),
    inlinePath: z.string().optional(),
    reportPath: z.string().optional(),
    lineCount: memoryHostFiniteNumberSchema,
    storageMode: z.enum(["inline", "separate", "both"]),
  }),
]);

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

/** Validate and bound one diagnostic event before storing it in plugin state. */
export function normalizeMemoryHostEventRecordForStorage(
  value: unknown,
): MemoryHostEventRecord | null {
  const parsed = memoryHostEventRecordSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const event = parsed.data;
  const timestamp = truncateUtf8(event.timestamp, 128);
  let truncated = timestamp.truncated || event.storageTruncated === true;

  if (event.type === "memory.recall.recorded" || event.type === "memory.recall.skipped") {
    const query = truncateUtf8(event.query, MAX_MEMORY_HOST_EVENT_TEXT_BYTES);
    truncated ||= query.truncated || event.results.truncated;
    const results = event.results.items.map((result) => {
      const resultPath = truncateUtf8(result.path, MAX_MEMORY_HOST_EVENT_PATH_BYTES);
      truncated ||= resultPath.truncated;
      return {
        path: resultPath.value,
        startLine: result.startLine,
        endLine: result.endLine,
        score: result.score,
        ...(event.type === "memory.recall.skipped"
          ? { reason: "non-short-term-memory-path" as const }
          : {}),
      };
    });
    const normalized =
      event.type === "memory.recall.recorded"
        ? {
            type: "memory.recall.recorded" as const,
            timestamp: timestamp.value,
            query: query.value,
            resultCount: event.resultCount,
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
            eligibleResultCount: event.eligibleResultCount,
            skippedResultCount: event.skippedResultCount,
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

  if (event.type === "memory.promotion.applied") {
    const memoryPath = truncateUtf8(event.memoryPath, MAX_MEMORY_HOST_EVENT_PATH_BYTES);
    truncated ||= memoryPath.truncated || event.candidates.truncated;
    const candidates = event.candidates.items.map((candidate) => {
      const key = truncateUtf8(candidate.key, MAX_MEMORY_HOST_EVENT_PATH_BYTES);
      const candidatePath = truncateUtf8(candidate.path, MAX_MEMORY_HOST_EVENT_PATH_BYTES);
      truncated ||= key.truncated || candidatePath.truncated;
      return {
        key: key.value,
        path: candidatePath.value,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        score: candidate.score,
        recallCount: candidate.recallCount,
      };
    });
    const normalized = {
      type: "memory.promotion.applied" as const,
      timestamp: timestamp.value,
      memoryPath: memoryPath.value,
      applied: event.applied,
      candidates,
      ...(truncated ? { storageTruncated: true as const } : {}),
    };
    return Buffer.byteLength(JSON.stringify(normalized), "utf8") <= MAX_MEMORY_HOST_EVENT_JSON_BYTES
      ? normalized
      : { ...normalized, candidates: [], storageTruncated: true as const };
  }

  if (event.type === "memory.dream.completed") {
    const error = event.error
      ? truncateUtf8(event.error, MAX_MEMORY_HOST_EVENT_TEXT_BYTES)
      : undefined;
    const inlinePath = event.inlinePath
      ? truncateUtf8(event.inlinePath, MAX_MEMORY_HOST_EVENT_PATH_BYTES)
      : undefined;
    const reportPath = event.reportPath
      ? truncateUtf8(event.reportPath, MAX_MEMORY_HOST_EVENT_PATH_BYTES)
      : undefined;
    truncated ||= Boolean(error?.truncated || inlinePath?.truncated || reportPath?.truncated);
    return {
      type: event.type,
      timestamp: timestamp.value,
      phase: event.phase,
      ...(event.outcome ? { outcome: event.outcome } : {}),
      ...(error ? { error: error.value } : {}),
      ...(inlinePath ? { inlinePath: inlinePath.value } : {}),
      ...(reportPath ? { reportPath: reportPath.value } : {}),
      lineCount: event.lineCount,
      storageMode: event.storageMode,
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
