import path from "node:path";
import { parseDateFirstTimestampMs } from "@openclaw/normalization-core/number-coercion";
import {
  isSessionTranscriptProjectionUnavailableError,
  readRecentSessionTranscriptMessageEvents,
  readSessionTranscriptMessageEvents,
  resolveConcreteSessionStorePath,
  resolveSessionTranscriptReadTarget,
  waitForSessionTranscriptProjection,
  type SessionTranscriptMessageEvent,
  type SessionTranscriptReadScope,
  type TranscriptEvent,
} from "../config/sessions/session-accessor.js";
import {
  readRecentSessionTranscriptHistoryEvents,
  readSessionTranscriptHistoryEventById,
  readSessionTranscriptHistoryEventCount,
  readSessionTranscriptHistoryEventPage,
  readSessionTranscriptHistoryEvents,
} from "../config/sessions/session-accessor.sqlite-history-events.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { aggregateSqliteUsageSnapshots } from "./session-transcript-derived-readers.js";
import {
  attachOpenClawTranscriptMeta,
  projectTranscriptEntryMessage,
} from "./session-transcript-message.js";
import type {
  ReadRecentSessionMessagesOptions,
  ReadSessionMessagesAsyncOptions,
  SessionTranscriptUsageSnapshot,
} from "./session-utils.fs.js";
import {
  ArchivedTranscriptReader,
  buildSessionPreviewItems,
  readLatestSessionUsageFromTranscriptFileAsync,
} from "./session-utils.fs.js";
import type { SessionPreviewItem } from "./session-utils.types.js";

export type { ReadSessionMessagesAsyncOptions };
export { capArrayByJsonBytes } from "./session-utils.fs.js";
export { attachOpenClawTranscriptMeta } from "./session-transcript-message.js";
export { readSessionTranscriptVisibleMessageDeltaCore } from "../config/sessions/session-accessor.js";

export type { SessionTranscriptReadScope };

export type ReadRecentSessionMessagesResult = {
  activeLeafEntryId?: string | null;
  deltaCursor?: string;
  messages: unknown[];
  transcriptEvents?: TranscriptEvent[];
  transcriptPath?: string;
  transcriptSource?: "active" | "reset-archive";
  totalMessages: number;
};

type ReadSessionMessagesResult = {
  messages: unknown[];
  transcriptPath?: string;
};

type ReadSessionMessageByIdResult = {
  message?: unknown;
  seq?: number;
  oversized: boolean;
  found: boolean;
};

export type ResolvedTranscriptReadTarget = {
  agentId?: string;
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
};

export function resolveTranscriptReadTarget(
  scope: SessionTranscriptReadScope,
): ResolvedTranscriptReadTarget {
  const target = resolveSessionTranscriptReadTarget(scope);
  return {
    agentId: target.agentId,
    sessionFile: target.sessionKey ?? target.sessionId,
    sessionId: target.sessionId,
    ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
    storePath: target.storePath,
  };
}

export function toTranscriptReadScope(
  target: ResolvedTranscriptReadTarget,
): SessionTranscriptReadScope {
  return {
    ...(target.agentId ? { agentId: target.agentId } : {}),
    sessionId: target.sessionId,
    ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
    ...(target.storePath ? { storePath: target.storePath } : {}),
  };
}

function archivedTranscriptReader(target: ResolvedTranscriptReadTarget): ArchivedTranscriptReader {
  return new ArchivedTranscriptReader({
    agentId: target.agentId,
    sessionId: target.sessionId,
    storePath: target.storePath,
  });
}

function readTranscriptRecordTimestampMs(event: Record<string, unknown>): number | undefined {
  return parseDateFirstTimestampMs(event.timestamp);
}

function extractMessageRecord(
  event: unknown,
): { id?: string; message: unknown; recordTimestampMs?: number } | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const record = event as { id?: unknown; message?: unknown };
  if (record.message === undefined) {
    return undefined;
  }
  const recordTimestampMs = readTranscriptRecordTimestampMs(event as Record<string, unknown>);
  return {
    ...(typeof record.id === "string" ? { id: record.id } : {}),
    message: record.message,
    ...(recordTimestampMs !== undefined ? { recordTimestampMs } : {}),
  };
}

type SqliteMessageRecord = {
  id?: string;
  message: unknown;
  recordTimestampMs?: number;
  seq: number;
};

function extractMessageRecordsFromEventEntries(
  entries: readonly SessionTranscriptMessageEvent[],
): SqliteMessageRecord[] {
  return entries.flatMap((entry) => {
    const record = extractMessageRecord(entry.event);
    return record ? [{ ...record, seq: entry.seq }] : [];
  });
}

function readSqliteMessageRecords(target: ResolvedTranscriptReadTarget): SqliteMessageRecord[] {
  return extractMessageRecordsFromEventEntries(
    readSessionTranscriptMessageEvents(toTranscriptReadScope(target)),
  );
}

function projectSqliteHistoryEvents(entries: readonly SessionTranscriptMessageEvent[]): unknown[] {
  return entries.flatMap((entry) => {
    const message = projectTranscriptEntryMessage(entry.event, entry.seq);
    return message ? [message] : [];
  });
}

function readSqliteMessagesSync(target: ResolvedTranscriptReadTarget): unknown[] {
  return readSqliteMessageRecords(target).map(sqliteRecordMessageWithSeq);
}

function normalizeRecentSqliteReadOptions(opts?: Partial<ReadRecentSessionMessagesOptions>) {
  const maxMessages = Math.max(0, Math.floor(opts?.maxMessages ?? 0));
  const maxBytes =
    typeof opts?.maxBytes === "number" && Number.isFinite(opts.maxBytes)
      ? Math.max(1024, Math.floor(opts.maxBytes))
      : 8 * 1024 * 1024;
  const defaultMaxLines = maxMessages * 20 + 20;
  const maxLines =
    typeof opts?.maxLines === "number" && Number.isFinite(opts.maxLines)
      ? Math.max(maxMessages, Math.floor(opts.maxLines))
      : defaultMaxLines;
  return { maxMessages, maxBytes, maxLines };
}

async function readRecentSqliteMessageRecords(
  target: ResolvedTranscriptReadTarget,
  opts?: Partial<ReadRecentSessionMessagesOptions>,
): Promise<{
  activeLeafEntryId?: string | null;
  deltaCursor?: string;
  messages: unknown[];
  transcriptEvents: TranscriptEvent[];
  totalMessages: number;
}> {
  const normalized = normalizeRecentSqliteReadOptions(opts);
  const page = readRecentSessionTranscriptHistoryEvents(toTranscriptReadScope(target), normalized);
  return {
    ...(Object.hasOwn(page, "activeLeafEntryId")
      ? { activeLeafEntryId: page.activeLeafEntryId }
      : {}),
    ...(page.deltaCursor ? { deltaCursor: page.deltaCursor } : {}),
    messages: projectSqliteHistoryEvents(page.events),
    transcriptEvents: page.events.map((entry) => entry.event),
    totalMessages: page.totalMessages,
  };
}

function readRecentSqliteUsageMessages(
  target: ResolvedTranscriptReadTarget,
  maxBytes: number,
): unknown[] {
  const page = readRecentSessionTranscriptMessageEvents(toTranscriptReadScope(target), {
    maxBytes: Math.max(1024, Math.floor(Number.isFinite(maxBytes) ? maxBytes : 8 * 1024 * 1024)),
    maxLines: 1000,
    maxMessages: 1000,
  });
  return extractMessageRecordsFromEventEntries(page.events).map((record) => record.message);
}

function sqliteRecordMessageWithSeq(record: {
  id?: string;
  message: unknown;
  recordTimestampMs?: number;
  seq: number;
}): unknown {
  const rawIdempotencyKey = (record.message as { idempotencyKey?: unknown } | undefined)
    ?.idempotencyKey;
  const idempotencyKey =
    typeof rawIdempotencyKey === "string" && rawIdempotencyKey.trim()
      ? rawIdempotencyKey.trim()
      : undefined;
  return attachOpenClawTranscriptMeta(record.message, {
    ...(record.id ? { id: record.id } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(record.recordTimestampMs !== undefined
      ? { recordTimestampMs: record.recordTimestampMs }
      : {}),
    seq: record.seq,
  });
}

export function sqliteMessageEventWithSeq(entry: SessionTranscriptMessageEvent): unknown {
  return projectTranscriptEntryMessage(entry.event, entry.seq);
}

function readSqliteAggregateUsageSnapshot(
  target: ResolvedTranscriptReadTarget,
): SessionTranscriptUsageSnapshot | null {
  return aggregateSqliteUsageSnapshots(readSqliteMessagesSync(target));
}

function buildSqlitePreviewItems(
  target: ResolvedTranscriptReadTarget,
  maxItems: number,
  maxChars: number,
): SessionPreviewItem[] {
  // Tool-only and suppressed rows need headroom; cap even the recovery scan so previews
  // never materialize an entire large transcript or monopolize the Gateway thread.
  const initialMaxEvents = Math.min(256, Math.max(64, Math.ceil(maxItems) * 4));
  const readPreviewPage = (maxEvents: number, maxBytes: number) => {
    const page = readRecentSessionTranscriptHistoryEvents(toTranscriptReadScope(target), {
      maxBytes,
      maxLines: maxEvents,
      maxMessages: maxEvents,
    });
    return {
      items: buildSessionPreviewItems(
        extractMessageRecordsFromEventEntries(page.events).map(sqliteRecordMessageWithSeq),
        maxItems,
        maxChars,
      ),
      hasOlderEvents: page.totalMessages > page.events.length,
    };
  };
  const preview = readPreviewPage(initialMaxEvents, 1024 * 1024);
  if (preview.items.length >= maxItems || !preview.hasOlderEvents) {
    return preview.items;
  }
  const recoveryMaxEvents = Math.min(
    2048,
    Math.max(1024, initialMaxEvents * 8, Math.ceil(maxItems)),
  );
  return readPreviewPage(recoveryMaxEvents, 8 * 1024 * 1024).items;
}

/** Reads display messages asynchronously through the reader seam. */
export async function readSessionMessagesAsync(
  scope: SessionTranscriptReadScope,
  opts: ReadSessionMessagesAsyncOptions,
): Promise<unknown[]> {
  return (await readSessionMessagesWithSourceAsync(scope, opts)).messages;
}

/** Reads display messages with source metadata through the reader seam. */
export async function readSessionMessagesWithSourceAsync(
  scope: SessionTranscriptReadScope,
  opts: ReadSessionMessagesAsyncOptions,
): Promise<ReadSessionMessagesResult> {
  const target = resolveTranscriptReadTarget(scope);
  const messages =
    opts.mode === "recent"
      ? (await readRecentSqliteMessageRecords(target, opts)).messages
      : projectSqliteHistoryEvents(
          readSessionTranscriptHistoryEvents(toTranscriptReadScope(target)),
        );
  if (messages.length === 0 && opts.allowResetArchiveFallback === true) {
    return await archivedTranscriptReader(target).read({ ...opts, resetArchiveOnly: true });
  }
  return {
    messages,
    transcriptPath: target.sessionFile,
  };
}

/** Finds one display message by transcript id through the reader seam. */
export async function readSessionMessageByIdAsync(
  scope: SessionTranscriptReadScope,
  messageId: string,
  opts?: { allowResetArchiveFallback?: boolean },
): Promise<ReadSessionMessageByIdResult> {
  const target = resolveTranscriptReadTarget(scope);
  const foundEvent = readSessionTranscriptHistoryEventById(
    toTranscriptReadScope(target),
    messageId,
  );
  if (foundEvent) {
    return {
      found: true,
      message: projectTranscriptEntryMessage(foundEvent.event, foundEvent.seq),
      oversized: false,
      seq: foundEvent.seq,
    };
  }
  if (opts?.allowResetArchiveFallback === true) {
    return await archivedTranscriptReader(target).readById(messageId, {
      ...opts,
      resetArchiveOnly: true,
    });
  }
  return { found: false, oversized: false };
}

/** Visits display messages asynchronously through the reader seam. */
export async function visitSessionMessagesAsync(
  scope: SessionTranscriptReadScope,
  visit: (message: unknown, seq: number) => void,
  _opts: { mode: "full"; reason: string; cache?: "reuse" | "skip" },
): Promise<number> {
  const target = resolveTranscriptReadTarget(scope);
  let count = 0;
  for (const record of readSqliteMessageRecords(target)) {
    visit(record.message, record.seq);
    count += 1;
  }
  return count;
}

/** Counts display messages asynchronously through the reader seam. */
export async function readSessionMessageCountAsync(
  scope: SessionTranscriptReadScope,
): Promise<number> {
  const target = resolveTranscriptReadTarget(scope);
  const transcriptScope = toTranscriptReadScope(target);
  try {
    return readSessionTranscriptHistoryEventCount(transcriptScope);
  } catch (error) {
    if (!isSessionTranscriptProjectionUnavailableError(error)) {
      throw error;
    }
    // The failed read already scheduled the rebuild; wait before assigning
    // a sequence so a concurrent send cannot fail or reuse a stale count.
    await waitForSessionTranscriptProjection(transcriptScope);
    return readSessionTranscriptHistoryEventCount(transcriptScope);
  }
}

/** Reads recent messages with total-count metadata asynchronously through the reader seam. */
export async function readRecentSessionMessagesWithStatsAsync(
  scope: SessionTranscriptReadScope,
  opts: ReadRecentSessionMessagesOptions,
): Promise<ReadRecentSessionMessagesResult> {
  const target = resolveTranscriptReadTarget(scope);
  const { activeLeafEntryId, deltaCursor, messages, transcriptEvents, totalMessages } =
    await readRecentSqliteMessageRecords(target, opts);
  if (totalMessages === 0 && messages.length === 0 && opts.allowResetArchiveFallback === true) {
    return await archivedTranscriptReader(target).readRecentWithStats({
      ...opts,
      resetArchiveOnly: true,
    });
  }
  return {
    ...(activeLeafEntryId !== undefined ? { activeLeafEntryId } : {}),
    ...(deltaCursor ? { deltaCursor } : {}),
    messages,
    transcriptEvents,
    totalMessages,
    transcriptPath: target.sessionFile,
    transcriptSource: "active",
  };
}

/** Reads one offset page with total-count metadata through the reader seam. */
export async function readSessionMessagesPageWithStatsAsync(
  scope: SessionTranscriptReadScope,
  opts: { offset: number; maxMessages: number; allowResetArchiveFallback?: boolean },
): Promise<ReadRecentSessionMessagesResult> {
  const target = resolveTranscriptReadTarget(scope);
  const page = readSessionTranscriptHistoryEventPage(toTranscriptReadScope(target), opts);
  if (page.totalMessages === 0 && opts.allowResetArchiveFallback === true) {
    return await archivedTranscriptReader(target).readPage({ ...opts, resetArchiveOnly: true });
  }
  return {
    ...(Object.hasOwn(page, "activeLeafEntryId")
      ? { activeLeafEntryId: page.activeLeafEntryId }
      : {}),
    messages: projectSqliteHistoryEvents(page.events),
    transcriptEvents: page.events.map((entry) => entry.event),
    totalMessages: page.totalMessages,
    transcriptPath: target.sessionFile,
    transcriptSource: "active",
  };
}

/** Reads aggregate usage from a full transcript asynchronously through the reader seam. */
export async function readLatestSessionUsageFromTranscriptAsync(
  scope: SessionTranscriptReadScope,
): Promise<SessionTranscriptUsageSnapshot | null> {
  const artifactFile = scope.sessionFile?.trim();
  const concreteStorePath = resolveConcreteSessionStorePath(scope.storePath);
  const targetAgentId = scope.agentId?.trim() || resolveAgentIdFromSessionKey(scope.sessionKey);
  const hasCompleteTarget = Boolean(targetAgentId && scope.sessionKey?.trim() && concreteStorePath);
  if (
    !hasCompleteTarget &&
    artifactFile &&
    path.isAbsolute(artifactFile) &&
    artifactFile.endsWith(".jsonl")
  ) {
    return await readLatestSessionUsageFromTranscriptFileAsync(
      scope.sessionId,
      concreteStorePath,
      artifactFile,
      undefined,
    );
  }
  const target = resolveTranscriptReadTarget(scope);
  return readSqliteAggregateUsageSnapshot(target);
}

/** Reads aggregate usage from a bounded transcript tail synchronously through the reader seam. */
export function readRecentSessionUsageFromTranscript(
  scope: SessionTranscriptReadScope,
  maxBytes: number,
): SessionTranscriptUsageSnapshot | null {
  const target = resolveTranscriptReadTarget(scope);
  return aggregateSqliteUsageSnapshots(readRecentSqliteUsageMessages(target, maxBytes));
}

/** Reads compact session preview items through the reader seam. */
export function readSessionPreviewItemsFromTranscript(
  scope: SessionTranscriptReadScope,
  maxItems: number,
  maxChars: number,
): SessionPreviewItem[] {
  const target = resolveTranscriptReadTarget(scope);
  return buildSqlitePreviewItems(target, maxItems, maxChars);
}
