import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import {
  appendSqliteTranscriptEvent,
  appendSqliteTranscriptEventSync,
  appendSqliteTranscriptMessage,
  appendSqliteTranscriptMessageSync,
  findSqliteTranscriptEvent,
  loadLatestSqliteAssistantText,
  loadSqliteTranscriptEventRowsAfterSeqSync,
  loadSqliteTranscriptEvents,
  loadSqliteTranscriptEventsSync,
  readSqliteTranscriptStatsSync,
  readSqliteTranscriptEventAtSeqSync,
  readSqliteTranscriptRawDelta,
  publishSqliteTranscriptUpdate,
  replaceSqliteTranscriptEvents,
  replaceSqliteTranscriptEventsSync,
  resolveSqliteSessionKeyBySessionId,
  trimSqliteTranscriptForManualCompact,
  withSqliteTranscriptWriteLock,
  withSqliteTranscriptWriteTransaction,
} from "./session-accessor.sqlite.js";
import type {
  SessionTranscriptAccessScope,
  SessionTranscriptRuntimeScope,
  SessionTranscriptReadScope,
  SessionTranscriptWriteScope,
  TranscriptEvent,
  SessionTranscriptStats,
  SessionTranscriptEventRow,
  SessionTranscriptRawDeltaLimits,
  SessionTranscriptRawDeltaResult,
  TranscriptMessageAppendOptions,
  TranscriptMessageAppendResult,
  TranscriptUpdatePayload,
  LatestTranscriptAssistantText,
  SessionTranscriptWriteLockAccessorContext,
  SessionTranscriptWriteTransactionContext,
  SessionTranscriptManualTrimResult,
  SessionTranscriptManualTrimPreflightResult,
} from "./session-accessor.types.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

/** Keeps transcript event delivery behind the transcript owner boundary. */
export function emitTranscriptUpdate(
  update: Parameters<typeof emitSessionTranscriptUpdate>[0],
): void {
  emitSessionTranscriptUpdate(update);
}

/**
 * Appends a non-message transcript record such as session or metadata events.
 * Message records must use appendTranscriptMessage so parent links, idempotency,
 * and redaction are preserved.
 */
export async function appendTranscriptEvent(
  scope: SessionTranscriptAccessScope,
  event: TranscriptEvent,
): Promise<void> {
  await appendSqliteTranscriptEvent(scope, event);
}

/** Appends a non-message transcript record synchronously for sync session runtimes. */
export function appendTranscriptEventSync(
  scope: SessionTranscriptAccessScope,
  event: TranscriptEvent,
): boolean {
  return appendSqliteTranscriptEventSync(scope, event);
}

/** Reads parsed transcript records from an explicit or derived transcript target. */
export async function loadTranscriptEvents(
  scope: SessionTranscriptReadScope,
): Promise<TranscriptEvent[]> {
  return await loadSqliteTranscriptEvents(scope);
}

/** Reads one bounded raw transcript page using an opaque generation-aware cursor. */
export function readTranscriptRawDelta(
  scope: SessionTranscriptReadScope,
  limits: SessionTranscriptRawDeltaLimits = {},
): SessionTranscriptRawDeltaResult {
  return readSqliteTranscriptRawDelta(scope, limits);
}

/** Replaces all transcript records for one SQLite-backed transcript. */
export async function replaceTranscriptEvents(
  scope: SessionTranscriptAccessScope,
  events: TranscriptEvent[],
): Promise<void> {
  await replaceSqliteTranscriptEvents(scope, events);
}

/** Replaces all transcript records synchronously for sync session runtimes. */
export function replaceTranscriptEventsSync(
  scope: SessionTranscriptAccessScope,
  events: TranscriptEvent[],
): boolean {
  return replaceSqliteTranscriptEventsSync(scope, events);
}

/** Reads parsed transcript records synchronously from the SQLite transcript store. */
export function loadTranscriptEventsSync(scope: SessionTranscriptReadScope): TranscriptEvent[] {
  return loadSqliteTranscriptEventsSync(scope);
}

/** Reads only rows appended after a previously observed SQLite sequence. */
export function loadTranscriptEventRowsAfterSeqSync(
  scope: SessionTranscriptReadScope,
  afterSeq: number,
  throughSeq?: number,
): SessionTranscriptEventRow[] {
  return loadSqliteTranscriptEventRowsAfterSeqSync(scope, afterSeq, throughSeq);
}

/** Reads one durable SQLite transcript row for incremental checkpoint validation. */
export function readTranscriptEventAtSeqSync(
  scope: SessionTranscriptReadScope,
  seq: number,
): SessionTranscriptEventRow | undefined {
  return readSqliteTranscriptEventAtSeqSync(scope, seq);
}

/** Reads transcript freshness and byte size without materializing event rows. */
export function readTranscriptStatsSync(scope: SessionTranscriptReadScope): SessionTranscriptStats {
  return readSqliteTranscriptStatsSync(scope);
}

/** Reads the latest visible assistant text without materializing the whole transcript. */
export function readLatestTranscriptAssistantText(
  scope: SessionTranscriptReadScope,
  options: { includeTranscriptOnlyOpenClawAssistant?: boolean } = {},
): LatestTranscriptAssistantText | undefined {
  return loadLatestSqliteAssistantText(scope, options);
}

/**
 * Appends one transcript message with message-id generation and optional
 * idempotency lookup. The returned message is the redacted persisted value.
 */
export async function appendTranscriptMessage<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage> & {
    prepareMessageAfterIdempotencyCheck: (message: TMessage) => TMessage | undefined;
  },
): Promise<TranscriptMessageAppendResult<TMessage> | undefined>;
export async function appendTranscriptMessage<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
): Promise<TranscriptMessageAppendResult<TMessage>>;
export async function appendTranscriptMessage<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
): Promise<TranscriptMessageAppendResult<TMessage> | undefined> {
  return await appendSqliteTranscriptMessage(scope, options);
}

/** Appends one transcript message synchronously for sync session runtimes. */
export function appendTranscriptMessageSync<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
): TranscriptMessageAppendResult<TMessage> | undefined {
  return appendSqliteTranscriptMessageSync(scope, options);
}

/** Resolves the persisted key for a SQLite transcript session id. */
export function resolveTranscriptSessionKeyBySessionId(
  scope: Pick<SessionTranscriptReadScope, "agentId" | "env" | "sessionId" | "storePath">,
): string | undefined {
  return resolveSqliteSessionKeyBySessionId(scope);
}

/**
 * Finds the newest transcript record accepted by the matcher. Reads rows
 * newest-first with early exit so hot append-path lookups never parse the
 * whole transcript; missing transcripts match nothing. The match is wrapped
 * so parsed falsy records stay distinguishable from "no match".
 */
export async function findTranscriptEvent(
  scope: SessionTranscriptReadScope,
  match: (event: TranscriptEvent) => boolean,
): Promise<{ event: TranscriptEvent } | undefined> {
  return findSqliteTranscriptEvent(scope, match);
}

/** Emits a transcript update after resolving the current transcript target. */
export async function publishTranscriptUpdate(
  scope: SessionTranscriptWriteScope,
  update: TranscriptUpdatePayload = {},
): Promise<void> {
  await publishSqliteTranscriptUpdate(scope, update);
}

/** Runs transcript read/append work under the backing store writer lock. */
export async function withTranscriptWriteLock<T>(
  scope: SessionTranscriptWriteScope,
  run: (context: SessionTranscriptWriteLockAccessorContext) => Promise<T> | T,
): Promise<T> {
  return await withSqliteTranscriptWriteLock(scope, run);
}

/** Runs a synchronous DAG batch under one transcript writer queue and transaction. */
export async function withTranscriptWriteTransaction<T>(
  scope: SessionTranscriptWriteScope,
  run: (context: SessionTranscriptWriteTransactionContext) => T,
): Promise<T> {
  return await withSqliteTranscriptWriteTransaction(scope, run);
}

/**
 * Trims a transcript for manual sessions.compact and clears stale token metadata.
 * This is one storage-sized mutation: future stores can trim transcript rows and
 * update entry metadata inside the same backend transaction.
 */
export async function preflightSessionTranscriptForManualCompact(
  scope: SessionTranscriptRuntimeScope,
  params: { maxLines: number; sessionFile?: string },
): Promise<SessionTranscriptManualTrimPreflightResult> {
  const events = await loadTranscriptEvents(scope).catch(() => []);
  if (events.length === 0) {
    return { compacted: false, reason: "no transcript" };
  }

  const maxLines = Math.max(1, Math.floor(params.maxLines));
  return events.length > maxLines ? { compacted: true } : { compacted: false, kept: events.length };
}

export async function trimSessionTranscriptForManualCompact(
  scope: SessionTranscriptRuntimeScope,
  params: { maxLines: number; nowMs?: number; sessionFile?: string },
): Promise<SessionTranscriptManualTrimResult> {
  const maxLines = Math.max(1, Math.floor(params.maxLines));
  const maxTailLines = Math.max(0, maxLines - 1);
  let declined: SessionTranscriptManualTrimResult = { compacted: false, reason: "no transcript" };
  const trimmed = await trimSqliteTranscriptForManualCompact(
    scope,
    (lines) => {
      if (lines.length === 0) {
        declined = { compacted: false, reason: "no transcript" };
        return null;
      }
      if (lines.length <= maxLines) {
        declined = { compacted: false, kept: lines.length };
        return null;
      }
      const tailLines = lines.slice(1);
      const retainedLines = normalizeManualCompactTranscriptLines(
        lines[0],
        maxTailLines > 0 ? tailLines.slice(-maxTailLines) : [],
      );
      if (!retainedLines) {
        declined = { compacted: false, kept: 0 };
        return null;
      }
      return retainedLines;
    },
    params.nowMs === undefined ? {} : { nowMs: params.nowMs },
  );
  if (!trimmed.trimmed) {
    return declined;
  }

  return { archived: trimmed.archivedPath, compacted: true, kept: trimmed.kept };
}

function parseManualCompactTranscriptRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizeManualCompactTranscriptLines(
  headerLine: string | undefined,
  tailLines: readonly string[],
): string[] | null {
  if (!headerLine) {
    return null;
  }
  const header = parseManualCompactTranscriptRecord(headerLine);
  if (header?.type !== "session" || typeof header.id !== "string") {
    return null;
  }

  const records = tailLines
    .map(parseManualCompactTranscriptRecord)
    .filter((record): record is Record<string, unknown> => record !== null);
  const retainedIds = new Set<string>();
  const transparentParents = new Map<string, string | null>();
  const normalizedRecords: Record<string, unknown>[] = [];
  for (const record of records) {
    let parentId = record.parentId;
    const seenTransparentParents = new Set<string>();
    while (
      typeof parentId === "string" &&
      transparentParents.has(parentId) &&
      !seenTransparentParents.has(parentId)
    ) {
      seenTransparentParents.add(parentId);
      parentId = transparentParents.get(parentId) ?? null;
    }
    let next =
      typeof parentId === "string" && !retainedIds.has(parentId)
        ? { ...record, parentId: null }
        : parentId !== record.parentId
          ? { ...record, parentId }
          : record;
    if (next.type === "leaf") {
      const targetId = next.targetId;
      const validTargetId =
        targetId === null || (typeof targetId === "string" && targetId.trim().length > 0);
      if (!validTargetId && typeof next.id === "string") {
        transparentParents.set(
          next.id,
          next.parentId === null || typeof next.parentId === "string" ? next.parentId : null,
        );
      }
      if (typeof targetId === "string" && targetId.trim() && !retainedIds.has(targetId)) {
        // The selected branch fell outside the retained window. Select an
        // empty root instead of accidentally activating abandoned or side rows.
        next = { ...next, targetId: null, appendParentId: null };
      } else if (
        validTargetId &&
        typeof next.appendParentId === "string" &&
        !retainedIds.has(next.appendParentId)
      ) {
        next = { ...next, appendParentId: targetId };
      }
    }
    if ((next.type === "compaction" || next.type === "reset") && typeof next.id === "string") {
      const firstKeptEntryId = next.firstKeptEntryId;
      if (typeof firstKeptEntryId === "string" && firstKeptEntryId !== next.id) {
        const tree = scanSessionTranscriptTree([...normalizedRecords, next]);
        const branchPath = selectSessionTranscriptTreePathNodes(tree, next.id);
        if (!branchPath.some((node) => node.id === firstKeptEntryId)) {
          // Replay starts at the earliest retained entry on this compaction's
          // normalized branch, never at an abandoned row earlier in file order.
          next = { ...next, firstKeptEntryId: branchPath[0]?.id ?? next.id };
        }
      }
    }
    normalizedRecords.push(next);
    if (typeof next.id === "string" && next.id.trim()) {
      retainedIds.add(next.id);
    }
  }
  return [JSON.stringify(header), ...normalizedRecords.map((record) => JSON.stringify(record))];
}
