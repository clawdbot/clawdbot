import {
  deriveSessionTotalTokens,
  hasNonzeroUsage,
  normalizeUsage,
  type UsageLike,
} from "../agents/usage.js";
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.js";
import {
  loadTranscriptEvents,
  loadTranscriptEventsSync,
  resolveSessionTranscriptReadTarget,
} from "../config/sessions/session-accessor.js";
import { parseSqliteSessionFileMarker } from "../config/sessions/sqlite-marker.js";
import {
  selectVisibleTranscriptEventEntries,
  type VisibleTranscriptEventEntry,
} from "../config/sessions/transcript-visible-events.js";
import { hasInterSessionUserProvenance } from "../sessions/input-provenance.js";
import type {
  ReadRecentSessionMessagesOptions,
  ReadSessionMessagesAsyncOptions,
  SessionTranscriptUsageSnapshot,
} from "./session-utils.fs.js";
import {
  attachOpenClawTranscriptMeta,
  buildSessionPreviewItems,
  readFirstUserMessageFromTranscript as readFirstUserMessageFromTranscriptFile,
  readLatestRecentSessionUsageFromTranscriptAsync as readLatestRecentSessionUsageFromTranscriptAsyncFile,
  readLatestSessionUsageFromTranscript as readLatestSessionUsageFromTranscriptFile,
  readLatestSessionUsageFromTranscriptAsync as readLatestSessionUsageFromTranscriptAsyncFile,
  readRecentSessionMessages as readRecentSessionMessagesFile,
  readRecentSessionMessagesAsync as readRecentSessionMessagesAsyncFile,
  readRecentSessionMessagesWithStats as readRecentSessionMessagesWithStatsFile,
  readRecentSessionMessagesWithStatsAsync as readRecentSessionMessagesWithStatsAsyncFile,
  readRecentSessionTranscriptLines as readRecentSessionTranscriptLinesFile,
  readSessionMessagesPageWithStatsAsync as readSessionMessagesPageWithStatsAsyncFile,
  readRecentSessionUsageFromTranscript as readRecentSessionUsageFromTranscriptFile,
  readRecentSessionUsageFromTranscriptAsync as readRecentSessionUsageFromTranscriptAsyncFile,
  readSessionMessageByIdAsync as readSessionMessageByIdAsyncFile,
  readSessionMessageCount as readSessionMessageCountFile,
  readSessionMessageCountAsync as readSessionMessageCountAsyncFile,
  readSessionMessages as readSessionMessagesFile,
  readSessionMessagesAsync as readSessionMessagesAsyncFile,
  readSessionMessagesWithSourceAsync as readSessionMessagesWithSourceAsyncFile,
  readSessionPreviewItemsFromTranscript as readSessionPreviewItemsFromTranscriptFile,
  readSessionTitleFieldsFromTranscript as readSessionTitleFieldsFromTranscriptFile,
  readSessionTitleFieldsFromTranscriptAsync as readSessionTitleFieldsFromTranscriptAsyncFile,
  visitSessionMessages as visitSessionMessagesFile,
  visitSessionMessagesAsync as visitSessionMessagesAsyncFile,
} from "./session-utils.fs.js";
import type { SessionPreviewItem } from "./session-utils.types.js";

export type { ReadRecentSessionMessagesOptions, ReadSessionMessagesAsyncOptions };
export { attachOpenClawTranscriptMeta, capArrayByJsonBytes } from "./session-utils.fs.js";

export type { SessionTranscriptReadScope };

type SessionTitleFields = {
  firstUserMessage: string | null;
  lastMessagePreview: string | null;
};

type ReadRecentSessionMessagesResult = {
  messages: unknown[];
  transcriptPath?: string;
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

function resolveTranscriptReadTarget(
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

function isSqliteReadTarget(target: ResolvedTranscriptReadTarget): boolean {
  return parseSqliteSessionFileMarker(target.sessionFile) !== undefined;
}

function toTranscriptReadScope(target: ResolvedTranscriptReadTarget): SessionTranscriptReadScope {
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

function extractMessageRecordsFromEventEntries(entries: VisibleTranscriptEventEntry<unknown>[]): {
  id?: string;
  message: unknown;
  recordTimestampMs?: number;
  seq: number;
}[] {
  return entries.flatMap((entry) => {
    const record = extractMessageRecord(entry.event);
    return record ? [{ ...record, seq: entry.seq }] : [];
  });
}

function readSqliteMessageRecordsSync(target: ResolvedTranscriptReadTarget): {
  id?: string;
  message: unknown;
  recordTimestampMs?: number;
  seq: number;
}[] {
  return extractMessageRecordsFromEventEntries(
    selectVisibleTranscriptEventEntries(loadTranscriptEventsSync(toTranscriptReadScope(target))),
  );
}

async function readSqliteMessageRecords(target: ResolvedTranscriptReadTarget): Promise<
  {
    id?: string;
    message: unknown;
    recordTimestampMs?: number;
    seq: number;
  }[]
> {
  return extractMessageRecordsFromEventEntries(
    selectVisibleTranscriptEventEntries(await loadTranscriptEvents(toTranscriptReadScope(target))),
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

function selectRecentSqliteEventEntries(
  entries: VisibleTranscriptEventEntry<unknown>[],
  opts: { maxBytes: number; maxLines: number },
) {
  const selected: VisibleTranscriptEventEntry<unknown>[] = [];
  let bytes = 0;
  for (const entry of entries.toReversed()) {
    const line = JSON.stringify(entry.event);
    const lineBytes = Buffer.byteLength(line) + 1;
    if (selected.length > 0 && bytes + lineBytes > opts.maxBytes) {
      break;
    }
    selected.push(entry);
    bytes += lineBytes;
    if (selected.length >= opts.maxLines) {
      break;
    }
  }
  return selected.toReversed();
}

function readRecentSqliteMessageRecordsSync(
  target: ResolvedTranscriptReadTarget,
  opts?: Partial<ReadRecentSessionMessagesOptions>,
): { id?: string; message: unknown; recordTimestampMs?: number; seq: number }[] {
  const normalized = normalizeRecentSqliteReadOptions(opts);
  const entries = selectVisibleTranscriptEventEntries(
    loadTranscriptEventsSync(toTranscriptReadScope(target)),
  );
  const records = extractMessageRecordsFromEventEntries(
    selectRecentSqliteEventEntries(entries, normalized),
  );
  return normalized.maxMessages > 0 ? records.slice(-normalized.maxMessages) : [];
}

async function readRecentSqliteMessageRecords(
  target: ResolvedTranscriptReadTarget,
  opts?: Partial<ReadRecentSessionMessagesOptions>,
): Promise<{ id?: string; message: unknown; recordTimestampMs?: number; seq: number }[]> {
  const normalized = normalizeRecentSqliteReadOptions(opts);
  const entries = selectVisibleTranscriptEventEntries(
    await loadTranscriptEvents(toTranscriptReadScope(target)),
  );
  const records = extractMessageRecordsFromEventEntries(
    selectRecentSqliteEventEntries(entries, normalized),
  );
  return normalized.maxMessages > 0 ? records.slice(-normalized.maxMessages) : [];
}

function readRecentSqliteUsageMessages(
  target: ResolvedTranscriptReadTarget,
  maxBytes: number,
): unknown[] {
  const entries = selectVisibleTranscriptEventEntries(
    loadTranscriptEventsSync(toTranscriptReadScope(target)),
  );
  return extractMessageRecordsFromEventEntries(
    selectRecentSqliteEventEntries(entries, {
      maxBytes: Math.max(1024, Math.floor(Number.isFinite(maxBytes) ? maxBytes : 8 * 1024 * 1024)),
      maxLines: 1000,
    }),
  ).map((record) => record.message);
}

function sqliteRecordMessageWithSeq(record: {
  id?: string;
  message: unknown;
  recordTimestampMs?: number;
  seq: number;
}): unknown {
  return attachOpenClawTranscriptMeta(record.message, {
    ...(record.id ? { id: record.id } : {}),
    ...(record.recordTimestampMs !== undefined
      ? { recordTimestampMs: record.recordTimestampMs }
      : {}),
    seq: record.seq,
  });
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

function extractSqliteUsageSnapshot(message: unknown): SessionTranscriptUsageSnapshot | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  const record = message as {
    model?: unknown;
    provider?: unknown;
    usage?: unknown;
  };
  const usageRaw =
    record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)
      ? (record.usage as UsageLike & { cost?: { total?: unknown }; costUsd?: unknown })
      : undefined;
  const usage = normalizeUsage(usageRaw);
  const normalizedUsage = usage ?? {};
  const totalTokens = deriveSessionTotalTokens({ usage });
  const modelProvider = typeof record.provider === "string" ? record.provider.trim() : undefined;
  const model = typeof record.model === "string" ? record.model.trim() : undefined;
  const costUsd =
    typeof usageRaw?.cost?.total === "number" && Number.isFinite(usageRaw.cost.total)
      ? usageRaw.cost.total
      : usageRaw?.costUsd;
  const hasMeaningfulUsage =
    hasNonzeroUsage(usage) ||
    typeof totalTokens === "number" ||
    (typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd > 0);
  const isDeliveryMirror = modelProvider === "openclaw" && model === "delivery-mirror";
  if (!hasMeaningfulUsage && !modelProvider && !model) {
    return null;
  }
  if (isDeliveryMirror && !hasMeaningfulUsage) {
    return null;
  }
  return {
    ...(!isDeliveryMirror && modelProvider ? { modelProvider } : {}),
    ...(!isDeliveryMirror && model ? { model } : {}),
    ...(typeof normalizedUsage.input === "number" ? { inputTokens: normalizedUsage.input } : {}),
    ...(typeof normalizedUsage.output === "number" ? { outputTokens: normalizedUsage.output } : {}),
    ...(typeof normalizedUsage.cacheRead === "number"
      ? { cacheRead: normalizedUsage.cacheRead }
      : {}),
    ...(typeof normalizedUsage.cacheWrite === "number"
      ? { cacheWrite: normalizedUsage.cacheWrite }
      : {}),
    ...(typeof totalTokens === "number" ? { totalTokens, totalTokensFresh: true } : {}),
    ...(typeof costUsd === "number" && Number.isFinite(costUsd) ? { costUsd } : {}),
  };
}

function readSqliteAggregateUsageSnapshot(
  target: ResolvedTranscriptReadTarget,
): SessionTranscriptUsageSnapshot | null {
  return aggregateSqliteUsageSnapshots(readSqliteMessagesSync(target));
}

function aggregateSqliteUsageSnapshots(messages: unknown[]): SessionTranscriptUsageSnapshot | null {
  const aggregate: SessionTranscriptUsageSnapshot = {};
  let sawUsage = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let costUsd = 0;
  let sawInput = false;
  let sawOutput = false;
  let sawCacheRead = false;
  let sawCacheWrite = false;
  let sawCost = false;
  for (const message of messages) {
    const snapshot = extractSqliteUsageSnapshot(message);
    if (!snapshot) {
      continue;
    }
    sawUsage = true;
    if (snapshot.modelProvider) {
      aggregate.modelProvider = snapshot.modelProvider;
    }
    if (snapshot.model) {
      aggregate.model = snapshot.model;
    }
    if (typeof snapshot.inputTokens === "number") {
      inputTokens += snapshot.inputTokens;
      sawInput = true;
    }
    if (typeof snapshot.outputTokens === "number") {
      outputTokens += snapshot.outputTokens;
      sawOutput = true;
    }
    if (typeof snapshot.cacheRead === "number") {
      cacheRead += snapshot.cacheRead;
      sawCacheRead = true;
    }
    if (typeof snapshot.cacheWrite === "number") {
      cacheWrite += snapshot.cacheWrite;
      sawCacheWrite = true;
    }
    if (typeof snapshot.totalTokens === "number") {
      aggregate.totalTokens = snapshot.totalTokens;
      aggregate.totalTokensFresh = true;
    }
    if (typeof snapshot.costUsd === "number") {
      costUsd += snapshot.costUsd;
      sawCost = true;
    }
  }
  if (!sawUsage) {
    return null;
  }
  if (sawInput) {
    aggregate.inputTokens = inputTokens;
  }
  if (sawOutput) {
    aggregate.outputTokens = outputTokens;
  }
  if (sawCacheRead) {
    aggregate.cacheRead = cacheRead;
  }
  if (sawCacheWrite) {
    aggregate.cacheWrite = cacheWrite;
  }
  if (sawCost) {
    aggregate.costUsd = costUsd;
  }
  return aggregate;
}

function buildSqlitePreviewItems(
  target: ResolvedTranscriptReadTarget,
  maxItems: number,
  maxChars: number,
): SessionPreviewItem[] {
  return buildSessionPreviewItems(readSqliteMessagesSync(target), maxItems, maxChars);
}

/** Reads display messages from a session transcript through the reader seam. */
export function readSessionMessages(scope: SessionTranscriptReadScope): unknown[] {
  const target = resolveTranscriptReadTarget(scope);
  if (isSqliteReadTarget(target)) {
    return readSqliteMessagesSync(target);
  }
  return readSessionMessagesFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    target.agentId,
  );
}

/** Reads recent display messages from a session transcript through the reader seam. */
export function readRecentSessionMessages(
  scope: SessionTranscriptReadScope,
  opts?: ReadRecentSessionMessagesOptions,
): unknown[] {
  const target = resolveTranscriptReadTarget(scope);
  if (isSqliteReadTarget(target)) {
    return readRecentSqliteMessageRecordsSync(target, opts).map(sqliteRecordMessageWithSeq);
  }
  return readRecentSessionMessagesFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    opts,
    target.agentId,
  );
}

/** Visits display messages from a session transcript through the reader seam. */
export function visitSessionMessages(
  scope: SessionTranscriptReadScope,
  visit: (message: unknown, seq: number) => void,
): number {
  const target = resolveTranscriptReadTarget(scope);
  if (isSqliteReadTarget(target)) {
    let count = 0;
    readSqliteMessagesSync(target).forEach((message, index) => {
      visit(message, index + 1);
      count += 1;
    });
    return count;
  }
  return visitSessionMessagesFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    visit,
    target.agentId,
  );
}

/** Counts display messages in a session transcript through the reader seam. */
export function readSessionMessageCount(scope: SessionTranscriptReadScope): number {
  const target = resolveTranscriptReadTarget(scope);
  if (isSqliteReadTarget(target)) {
    return readSqliteMessagesSync(target).length;
  }
  return readSessionMessageCountFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    target.agentId,
  );
}

/** Reads display messages asynchronously through the reader seam. */
export async function readSessionMessagesAsync(
  scope: SessionTranscriptReadScope,
  opts: ReadSessionMessagesAsyncOptions,
): Promise<unknown[]> {
  const target = resolveTranscriptReadTarget(scope);
  if (isSqliteReadTarget(target)) {
    if (opts.mode === "recent") {
      const records = await readRecentSqliteMessageRecords(target, opts);
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
        ? await readRecentSqliteMessageRecords(target, opts)
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

/** Reads recent display messages asynchronously through the reader seam. */
export async function readRecentSessionMessagesAsync(
  scope: SessionTranscriptReadScope,
  opts?: ReadRecentSessionMessagesOptions,
): Promise<unknown[]> {
  const target = resolveTranscriptReadTarget(scope);
  if (isSqliteReadTarget(target)) {
    const records = await readRecentSqliteMessageRecords(target, opts);
    if (records.length === 0 && opts?.allowResetArchiveFallback === true) {
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
  return await readRecentSessionMessagesAsyncFile(
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
    const found = (await readSqliteMessageRecords(target)).find(
      (record) => record.id === messageId,
    );
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
    return (await readSqliteMessageRecords(target)).length;
  }
  return await readSessionMessageCountAsyncFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    target.agentId,
  );
}

/** Reads recent messages with total-count metadata through the reader seam. */
export function readRecentSessionMessagesWithStats(
  scope: SessionTranscriptReadScope,
  opts: ReadRecentSessionMessagesOptions,
): ReadRecentSessionMessagesResult {
  const target = resolveTranscriptReadTarget(scope);
  if (isSqliteReadTarget(target)) {
    const records = readSqliteMessageRecordsSync(target);
    const recentRecords = readRecentSqliteMessageRecordsSync(target, opts);
    if (
      records.length === 0 &&
      recentRecords.length === 0 &&
      opts.allowResetArchiveFallback === true
    ) {
      return readRecentSessionMessagesWithStatsFile(
        target.sessionId,
        target.storePath,
        undefined,
        { ...opts, resetArchiveOnly: true },
        target.agentId,
      );
    }
    return {
      messages: recentRecords.map(sqliteRecordMessageWithSeq),
      totalMessages: records.length,
      transcriptPath: target.sessionFile,
    };
  }
  return readRecentSessionMessagesWithStatsFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    opts,
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
    const records = await readSqliteMessageRecords(target);
    const recentRecords = await readRecentSqliteMessageRecords(target, opts);
    if (
      records.length === 0 &&
      recentRecords.length === 0 &&
      opts.allowResetArchiveFallback === true
    ) {
      return await readRecentSessionMessagesWithStatsAsyncFile(
        target.sessionId,
        target.storePath,
        undefined,
        { ...opts, resetArchiveOnly: true },
        target.agentId,
      );
    }
    return {
      messages: recentRecords.map(sqliteRecordMessageWithSeq),
      totalMessages: records.length,
      transcriptPath: target.sessionFile,
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
    const records = await readSqliteMessageRecords(target);
    if (records.length === 0 && opts.allowResetArchiveFallback === true) {
      return await readSessionMessagesPageWithStatsAsyncFile(
        target.sessionId,
        target.storePath,
        undefined,
        { ...opts, resetArchiveOnly: true },
        target.agentId,
      );
    }
    const totalMessages = records.length;
    const offset = Math.min(
      Math.max(0, Math.floor(Number.isFinite(opts.offset) ? opts.offset : 0)),
      totalMessages,
    );
    const maxMessages = Math.max(
      0,
      Math.floor(Number.isFinite(opts.maxMessages) ? opts.maxMessages : 0),
    );
    const endExclusive = Math.max(0, totalMessages - offset);
    const start = Math.max(0, endExclusive - maxMessages);
    return {
      messages: records.slice(start, endExclusive).map(sqliteRecordMessageWithSeq),
      totalMessages,
      transcriptPath: target.sessionFile,
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

/** Reads a bounded transcript tail for compaction and diagnostics through the reader seam. */
export function readRecentSessionTranscriptLines(
  params: SessionTranscriptReadScope & {
    maxLines: number;
  },
): { lines: string[]; totalLines: number } | null {
  const target = resolveTranscriptReadTarget(params);
  if (isSqliteReadTarget(target)) {
    const lines = loadTranscriptEventsSync(toTranscriptReadScope(target)).map((event) =>
      JSON.stringify(event),
    );
    return { lines: lines.slice(-params.maxLines), totalLines: lines.length };
  }
  return readRecentSessionTranscriptLinesFile({
    sessionId: target.sessionId,
    storePath: target.storePath,
    sessionFile: target.sessionFile,
    agentId: target.agentId,
    maxLines: params.maxLines,
  });
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

/** Reads the first user message from a transcript through the reader seam. */
export function readFirstUserMessageFromTranscript(
  scope: SessionTranscriptReadScope,
  opts?: { includeInterSession?: boolean },
): string | null {
  const target = resolveTranscriptReadTarget(scope);
  if (isSqliteReadTarget(target)) {
    return readSqliteTitleFields(target, opts).firstUserMessage;
  }
  return readFirstUserMessageFromTranscriptFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    target.agentId,
    opts,
  );
}

/** Reads aggregate usage from a full transcript through the reader seam. */
export function readLatestSessionUsageFromTranscript(
  scope: SessionTranscriptReadScope,
): SessionTranscriptUsageSnapshot | null {
  const target = resolveTranscriptReadTarget(scope);
  if (isSqliteReadTarget(target)) {
    return readSqliteAggregateUsageSnapshot(target);
  }
  return readLatestSessionUsageFromTranscriptFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    target.agentId,
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

/** Reads aggregate usage from a bounded transcript tail through the reader seam. */
export async function readRecentSessionUsageFromTranscriptAsync(
  scope: SessionTranscriptReadScope,
  maxBytes: number,
): Promise<SessionTranscriptUsageSnapshot | null> {
  const target = resolveTranscriptReadTarget(scope);
  if (isSqliteReadTarget(target)) {
    return aggregateSqliteUsageSnapshots(readRecentSqliteUsageMessages(target, maxBytes));
  }
  return await readRecentSessionUsageFromTranscriptAsyncFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    target.agentId,
    maxBytes,
  );
}

/** Reads latest usage from a bounded transcript tail through the reader seam. */
export async function readLatestRecentSessionUsageFromTranscriptAsync(
  scope: SessionTranscriptReadScope,
  maxBytes: number,
): Promise<SessionTranscriptUsageSnapshot | null> {
  const target = resolveTranscriptReadTarget(scope);
  if (isSqliteReadTarget(target)) {
    for (const message of readRecentSqliteUsageMessages(target, maxBytes).toReversed()) {
      const snapshot = extractSqliteUsageSnapshot(message);
      if (snapshot) {
        return snapshot;
      }
    }
    return null;
  }
  return await readLatestRecentSessionUsageFromTranscriptAsyncFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    target.agentId,
    maxBytes,
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
