import {
  readRecentSessionTranscriptMessageEvents,
  readSessionTranscriptMessageEventById,
  readSessionTranscriptMessageEventCount,
  readSessionTranscriptMessageEventPage,
  readSessionTranscriptMessageEvents,
  resolveSessionTranscriptReadTarget,
  type SessionTranscriptMessageEvent,
  type SessionTranscriptReadScope,
  type TranscriptEvent,
} from "../config/sessions/session-accessor.js";
import { parseSqliteSessionFileMarker } from "../config/sessions/sqlite-marker.js";
import { hasInterSessionUserProvenance } from "../sessions/input-provenance.js";
import { aggregateSqliteUsageSnapshots } from "./session-transcript-derived-readers.js";
import type {
  ReadRecentSessionMessagesOptions,
  ReadSessionMessagesAsyncOptions,
  SessionTranscriptUsageSnapshot,
} from "./session-utils.fs.js";
import {
  attachOpenClawTranscriptMeta,
  buildSessionPreviewItems,
  readLatestSessionUsageFromTranscriptAsync as readLatestSessionUsageFromTranscriptAsyncFile,
  readRecentSessionMessagesAsync as readRecentSessionMessagesAsyncFile,
  readRecentSessionMessagesWithStatsAsync as readRecentSessionMessagesWithStatsAsyncFile,
  readSessionMessagesPageWithStatsAsync as readSessionMessagesPageWithStatsAsyncFile,
  readRecentSessionUsageFromTranscript as readRecentSessionUsageFromTranscriptFile,
  readSessionMessageByIdAsync as readSessionMessageByIdAsyncFile,
  readSessionMessageCountAsync as readSessionMessageCountAsyncFile,
  readSessionMessagesAsync as readSessionMessagesAsyncFile,
  readSessionMessagesWithSourceAsync as readSessionMessagesWithSourceAsyncFile,
  readSessionPreviewItemsFromTranscript as readSessionPreviewItemsFromTranscriptFile,
  readSessionTitleFieldsFromTranscript as readSessionTitleFieldsFromTranscriptFile,
  readSessionTitleFieldsFromTranscriptAsync as readSessionTitleFieldsFromTranscriptAsyncFile,
  visitSessionMessagesAsync as visitSessionMessagesAsyncFile,
} from "./session-utils.fs.js";
import type { SessionPreviewItem } from "./session-utils.types.js";

export type { ReadSessionMessagesAsyncOptions };
export { attachOpenClawTranscriptMeta, capArrayByJsonBytes } from "./session-utils.fs.js";

export type { SessionTranscriptReadScope };

type SessionTitleFields = {
  firstUserMessage: string | null;
  lastMessagePreview: string | null;
};

export type ReadRecentSessionMessagesResult = {
  activeLeafEntryId?: string | null;
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

type ResolvedTranscriptReadTarget = {
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
  const marker = parseSqliteSessionFileMarker(target.sessionFile);
  const storePath = resolveConcreteReadStorePath(scope.storePath);
  return {
    agentId: target.agentId ?? marker?.agentId,
    sessionFile: target.sessionFile,
    sessionId: marker?.sessionId ?? target.sessionId,
    ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
    ...((storePath ?? marker?.storePath) ? { storePath: storePath ?? marker?.storePath } : {}),
  };
}

function resolveConcreteReadStorePath(storePath: string | undefined): string | undefined {
  const trimmed = storePath?.trim();
  if (!trimmed || trimmed === "(multiple)" || trimmed.includes("{agentId}")) {
    return undefined;
  }
  return trimmed;
}

export function isSqliteReadTarget(target: ResolvedTranscriptReadTarget): boolean {
  return parseSqliteSessionFileMarker(target.sessionFile) !== undefined;
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

function readTranscriptRecordTimestampMs(event: Record<string, unknown>): number | undefined {
  const raw = event.timestamp;
  const timestampMs =
    typeof raw === "string" ? Date.parse(raw) : typeof raw === "number" ? raw : Number.NaN;
  return Number.isFinite(timestampMs) ? timestampMs : undefined;
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

function readSqliteMessageRecordsSync(target: ResolvedTranscriptReadTarget): SqliteMessageRecord[] {
  return extractMessageRecordsFromEventEntries(
    readSessionTranscriptMessageEvents(toTranscriptReadScope(target)),
  );
}

async function readSqliteMessageRecords(
  target: ResolvedTranscriptReadTarget,
): Promise<SqliteMessageRecord[]> {
  return extractMessageRecordsFromEventEntries(
    readSessionTranscriptMessageEvents(toTranscriptReadScope(target)),
  );
}

function readSqliteMessagesSync(target: ResolvedTranscriptReadTarget): unknown[] {
  return readSqliteMessageRecordsSync(target).map(sqliteRecordMessageWithSeq);
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
  records: SqliteMessageRecord[];
  transcriptEvents: TranscriptEvent[];
  totalMessages: number;
}> {
  const normalized = normalizeRecentSqliteReadOptions(opts);
  const page = readRecentSessionTranscriptMessageEvents(toTranscriptReadScope(target), normalized);
  return {
    ...(Object.hasOwn(page, "activeLeafEntryId")
      ? { activeLeafEntryId: page.activeLeafEntryId }
      : {}),
    records: extractMessageRecordsFromEventEntries(page.events),
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
  const record = extractMessageRecord(entry.event);
  return record ? sqliteRecordMessageWithSeq({ ...record, seq: entry.seq }) : undefined;
}

function extractMessageRole(message: unknown): string | undefined {
  return message && typeof message === "object" && !Array.isArray(message)
    ? ((message as { role?: unknown }).role as string | undefined)
    : undefined;
}

function extractMessageText(message: unknown): string | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  const record = message as { content?: unknown; text?: unknown };
  if (typeof record.content === "string") {
    return record.content.trim() || null;
  }
  if (Array.isArray(record.content)) {
    const text = record.content
      .map((entry) =>
        entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string"
          ? (entry as { text: string }).text
          : "",
      )
      .filter((part) => part.trim())
      .join("\n")
      .trim();
    return text || null;
  }
  if (typeof record.text === "string") {
    return record.text.trim() || null;
  }
  return null;
}

function readSqliteTitleFields(
  target: ResolvedTranscriptReadTarget,
  opts?: { includeInterSession?: boolean },
): SessionTitleFields {
  const messages = readSqliteMessagesSync(target);
  const firstUser = messages.find((message) => {
    if (extractMessageRole(message) !== "user") {
      return false;
    }
    return (
      opts?.includeInterSession === true ||
      !hasInterSessionUserProvenance(message as { role?: unknown; provenance?: unknown })
    );
  });
  const lastText = messages.toReversed().map(extractMessageText).find(Boolean) ?? null;
  return {
    firstUserMessage: firstUser ? extractMessageText(firstUser) : null,
    lastMessagePreview: lastText,
  };
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
  return buildSessionPreviewItems(readSqliteMessagesSync(target), maxItems, maxChars);
}

/** Reads display messages asynchronously through the reader seam. */
export async function readSessionMessagesAsync(
  scope: SessionTranscriptReadScope,
  opts: ReadSessionMessagesAsyncOptions,
): Promise<unknown[]> {
  const target = resolveTranscriptReadTarget(scope);
  if (isSqliteReadTarget(target)) {
    if (opts.mode === "recent") {
      const { records } = await readRecentSqliteMessageRecords(target, opts);
      if (records.length === 0 && opts.allowResetArchiveFallback === true) {
        return await readRecentSessionMessagesAsyncFile(
          target.sessionId,
          target.storePath,
          undefined,
          { ...opts, resetArchiveOnly: true },
          target.agentId,
        );
      }
      return records.map(sqliteRecordMessageWithSeq);
    }
    const records = await readSqliteMessageRecords(target);
    if (records.length === 0 && opts.allowResetArchiveFallback === true) {
      return await readSessionMessagesAsyncFile(
        target.sessionId,
        target.storePath,
        undefined,
        opts,
        target.agentId,
      );
    }
    return records.map(sqliteRecordMessageWithSeq);
  }
  return await readSessionMessagesAsyncFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    opts,
    target.agentId,
  );
}

/** Reads display messages with source metadata through the reader seam. */
export async function readSessionMessagesWithSourceAsync(
  scope: SessionTranscriptReadScope,
  opts: ReadSessionMessagesAsyncOptions,
): Promise<ReadSessionMessagesResult> {
  const target = resolveTranscriptReadTarget(scope);
  if (isSqliteReadTarget(target)) {
    const records =
      opts.mode === "recent"
        ? (await readRecentSqliteMessageRecords(target, opts)).records
        : await readSqliteMessageRecords(target);
    if (records.length === 0 && opts.allowResetArchiveFallback === true) {
      return await readSessionMessagesWithSourceAsyncFile(
        target.sessionId,
        target.storePath,
        undefined,
        { ...opts, resetArchiveOnly: true },
        target.agentId,
      );
    }
    const messages = records.map(sqliteRecordMessageWithSeq);
    return {
      messages,
      transcriptPath: target.sessionFile,
    };
  }
  return await readSessionMessagesWithSourceAsyncFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    opts,
    target.agentId,
  );
}

/** Finds one display message by transcript id through the reader seam. */
export async function readSessionMessageByIdAsync(
  scope: SessionTranscriptReadScope,
  messageId: string,
  opts?: { allowResetArchiveFallback?: boolean },
): Promise<ReadSessionMessageByIdResult> {
  const target = resolveTranscriptReadTarget(scope);
  if (isSqliteReadTarget(target)) {
    const foundEvent = readSessionTranscriptMessageEventById(
      toTranscriptReadScope(target),
      messageId,
    );
    const found = foundEvent
      ? extractMessageRecordsFromEventEntries([foundEvent]).at(0)
      : undefined;
    if (found) {
      return { found: true, message: found.message, oversized: false, seq: found.seq };
    }
    if (opts?.allowResetArchiveFallback === true) {
      return await readSessionMessageByIdAsyncFile(
        target.sessionId,
        target.storePath,
        undefined,
        messageId,
        { ...opts, agentId: target.agentId, resetArchiveOnly: true },
      );
    }
    return { found: false, oversized: false };
  }
  return await readSessionMessageByIdAsyncFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    messageId,
    { ...opts, agentId: target.agentId },
  );
}

/** Visits display messages asynchronously through the reader seam. */
export async function visitSessionMessagesAsync(
  scope: SessionTranscriptReadScope,
  visit: (message: unknown, seq: number) => void,
  opts: { mode: "full"; reason: string; cache?: "reuse" | "skip" },
): Promise<number> {
  const target = resolveTranscriptReadTarget(scope);
  if (isSqliteReadTarget(target)) {
    let count = 0;
    for (const record of await readSqliteMessageRecords(target)) {
      visit(record.message, record.seq);
      count += 1;
    }
    return count;
  }
  return await visitSessionMessagesAsyncFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    visit,
    opts,
    target.agentId,
  );
}

/** Counts display messages asynchronously through the reader seam. */
export async function readSessionMessageCountAsync(
  scope: SessionTranscriptReadScope,
): Promise<number> {
  const target = resolveTranscriptReadTarget(scope);
  if (isSqliteReadTarget(target)) {
    return readSessionTranscriptMessageEventCount(toTranscriptReadScope(target));
  }
  return await readSessionMessageCountAsyncFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    target.agentId,
  );
}

/** Reads recent messages with total-count metadata asynchronously through the reader seam. */
export async function readRecentSessionMessagesWithStatsAsync(
  scope: SessionTranscriptReadScope,
  opts: ReadRecentSessionMessagesOptions,
): Promise<ReadRecentSessionMessagesResult> {
  const target = resolveTranscriptReadTarget(scope);
  if (isSqliteReadTarget(target)) {
    const { activeLeafEntryId, records, transcriptEvents, totalMessages } =
      await readRecentSqliteMessageRecords(target, opts);
    if (totalMessages === 0 && records.length === 0 && opts.allowResetArchiveFallback === true) {
      return await readRecentSessionMessagesWithStatsAsyncFile(
        target.sessionId,
        target.storePath,
        undefined,
        { ...opts, resetArchiveOnly: true },
        target.agentId,
      );
    }
    return {
      ...(activeLeafEntryId !== undefined ? { activeLeafEntryId } : {}),
      messages: records.map(sqliteRecordMessageWithSeq),
      transcriptEvents,
      totalMessages,
      transcriptPath: target.sessionFile,
      transcriptSource: "active",
    };
  }
  return await readRecentSessionMessagesWithStatsAsyncFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    opts,
    target.agentId,
  );
}

/** Reads one offset page with total-count metadata through the reader seam. */
export async function readSessionMessagesPageWithStatsAsync(
  scope: SessionTranscriptReadScope,
  opts: { offset: number; maxMessages: number; allowResetArchiveFallback?: boolean },
): Promise<ReadRecentSessionMessagesResult> {
  const target = resolveTranscriptReadTarget(scope);
  if (isSqliteReadTarget(target)) {
    const page = readSessionTranscriptMessageEventPage(toTranscriptReadScope(target), opts);
    if (page.totalMessages === 0 && opts.allowResetArchiveFallback === true) {
      return await readSessionMessagesPageWithStatsAsyncFile(
        target.sessionId,
        target.storePath,
        undefined,
        { ...opts, resetArchiveOnly: true },
        target.agentId,
      );
    }
    return {
      ...(Object.hasOwn(page, "activeLeafEntryId")
        ? { activeLeafEntryId: page.activeLeafEntryId }
        : {}),
      messages: extractMessageRecordsFromEventEntries(page.events).map(sqliteRecordMessageWithSeq),
      transcriptEvents: page.events.map((entry) => entry.event),
      totalMessages: page.totalMessages,
      transcriptPath: target.sessionFile,
      transcriptSource: "active",
    };
  }
  return await readSessionMessagesPageWithStatsAsyncFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    opts,
    target.agentId,
  );
}

/** Reads title and preview text from a transcript through the reader seam. */
export function readSessionTitleFieldsFromTranscript(
  scope: SessionTranscriptReadScope,
  opts?: { includeInterSession?: boolean },
): SessionTitleFields {
  const target = resolveTranscriptReadTarget(scope);
  if (isSqliteReadTarget(target)) {
    return readSqliteTitleFields(target, opts);
  }
  return readSessionTitleFieldsFromTranscriptFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    target.agentId,
    opts,
  );
}

/** Reads title and preview text asynchronously through the reader seam. */
export async function readSessionTitleFieldsFromTranscriptAsync(
  scope: SessionTranscriptReadScope,
  opts?: { includeInterSession?: boolean },
): Promise<SessionTitleFields> {
  const target = resolveTranscriptReadTarget(scope);
  if (isSqliteReadTarget(target)) {
    return readSqliteTitleFields(target, opts);
  }
  return await readSessionTitleFieldsFromTranscriptAsyncFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    target.agentId,
    opts,
  );
}

/** Reads aggregate usage from a full transcript asynchronously through the reader seam. */
export async function readLatestSessionUsageFromTranscriptAsync(
  scope: SessionTranscriptReadScope,
): Promise<SessionTranscriptUsageSnapshot | null> {
  const target = resolveTranscriptReadTarget(scope);
  if (isSqliteReadTarget(target)) {
    return readSqliteAggregateUsageSnapshot(target);
  }
  return await readLatestSessionUsageFromTranscriptAsyncFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    target.agentId,
  );
}

/** Reads aggregate usage from a bounded transcript tail synchronously through the reader seam. */
export function readRecentSessionUsageFromTranscript(
  scope: SessionTranscriptReadScope,
  maxBytes: number,
): SessionTranscriptUsageSnapshot | null {
  const target = resolveTranscriptReadTarget(scope);
  if (isSqliteReadTarget(target)) {
    return aggregateSqliteUsageSnapshots(readRecentSqliteUsageMessages(target, maxBytes));
  }
  return readRecentSessionUsageFromTranscriptFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    target.agentId,
    maxBytes,
  );
}

/** Reads compact session preview items through the reader seam. */
export function readSessionPreviewItemsFromTranscript(
  scope: SessionTranscriptReadScope,
  maxItems: number,
  maxChars: number,
): ReturnType<typeof readSessionPreviewItemsFromTranscriptFile> {
  const target = resolveTranscriptReadTarget(scope);
  if (isSqliteReadTarget(target)) {
    return buildSqlitePreviewItems(target, maxItems, maxChars);
  }
  return readSessionPreviewItemsFromTranscriptFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    target.agentId,
    maxItems,
    maxChars,
  );
}
