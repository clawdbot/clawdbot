// Filesystem session history readers.
// Parses transcript JSONL files for messages, previews, counts, and usage metadata.
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { expectDefined } from "@openclaw/normalization-core";
import {
  resolveIntegerOption,
  resolveNonNegativeIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  deriveSessionTotalTokens,
  hasNonzeroUsage,
  normalizeUsage,
  type ContextUsage,
} from "../agents/usage.js";
import { materializeSessionArchiveForRead } from "../config/sessions/archive-compression.js";
import type { TranscriptEvent } from "../config/sessions/session-accessor.js";
import { selectSessionTranscriptActiveEntries } from "../config/sessions/transcript-tree.js";
import { readFileWindowFully, readFileWindowFullySync } from "../infra/file-read.js";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import { hasInterSessionUserProvenance } from "../sessions/input-provenance.js";
import { extractAssistantVisibleText } from "../shared/chat-message-content.js";
import { truncateUtf16Safe } from "../utils.js";
import { estimateStringChars, estimateTokensFromChars } from "../utils/cjk-chars.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import { extractToolCallNames, hasToolCall } from "../utils/transcript-tools.js";
import { stripEnvelope } from "./chat-sanitize.js";
import {
  resolveSessionTranscriptCandidates,
  resolveSessionTranscriptResetArchiveCandidatesAsync,
} from "./session-transcript-files.fs.js";
import {
  readSessionTranscriptIndex,
  type IndexedTranscriptEntry,
} from "./session-transcript-index.fs.js";
import {
  extractJsonNullableStringFieldPrefix,
  extractJsonNumberFieldPrefix,
  extractJsonStringFieldPrefix,
  readNonBlankStringPreservingWhitespace,
} from "./session-transcript-json.js";
import type { SessionPreviewItem } from "./session-utils.types.js";

type SessionTitleFields = {
  firstUserMessage: string | null;
  lastMessagePreview: string | null;
};

type SessionTitleFieldsCacheEntry = SessionTitleFields & {
  mtimeMs: number;
  size: number;
};

const sessionTitleFieldsCache = new Map<string, SessionTitleFieldsCacheEntry>();
const MAX_SESSION_TITLE_FIELDS_CACHE_ENTRIES = 5000;
const transcriptMessageCountCache = new Map<
  string,
  {
    mtimeMs: number;
    size: number;
    count: number;
  }
>();
const MAX_TRANSCRIPT_MESSAGE_COUNT_CACHE_ENTRIES = 5000;
const TRANSCRIPT_ASYNC_READ_CHUNK_BYTES = 64 * 1024;
type TranscriptFileHandle = Awaited<ReturnType<typeof fs.promises.open>>;

function readSessionTitleFieldsCacheKey(
  filePath: string,
  opts?: { includeInterSession?: boolean },
) {
  const includeInterSession = opts?.includeInterSession === true ? "1" : "0";
  return `${filePath}\t${includeInterSession}`;
}

function getCachedSessionTitleFields(cacheKey: string, stat: fs.Stats): SessionTitleFields | null {
  const cached = sessionTitleFieldsCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  if (cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
    sessionTitleFieldsCache.delete(cacheKey);
    return null;
  }
  // LRU bump
  sessionTitleFieldsCache.delete(cacheKey);
  sessionTitleFieldsCache.set(cacheKey, cached);
  return {
    firstUserMessage: cached.firstUserMessage,
    lastMessagePreview: cached.lastMessagePreview,
  };
}

function setCachedSessionTitleFields(cacheKey: string, stat: fs.Stats, value: SessionTitleFields) {
  sessionTitleFieldsCache.set(cacheKey, {
    ...value,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  });
  while (sessionTitleFieldsCache.size > MAX_SESSION_TITLE_FIELDS_CACHE_ENTRIES) {
    const oldestKey = sessionTitleFieldsCache.keys().next().value;
    if (typeof oldestKey !== "string" || !oldestKey) {
      break;
    }
    sessionTitleFieldsCache.delete(oldestKey);
  }
}

function getCachedTranscriptMessageCount(filePath: string, stat: fs.Stats): number | null {
  const cached = transcriptMessageCountCache.get(filePath);
  if (!cached) {
    return null;
  }
  if (cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
    transcriptMessageCountCache.delete(filePath);
    return null;
  }
  transcriptMessageCountCache.delete(filePath);
  transcriptMessageCountCache.set(filePath, cached);
  return cached.count;
}

function setCachedTranscriptMessageCount(filePath: string, stat: fs.Stats, count: number): void {
  transcriptMessageCountCache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    count,
  });
  while (transcriptMessageCountCache.size > MAX_TRANSCRIPT_MESSAGE_COUNT_CACHE_ENTRIES) {
    const oldestKey = transcriptMessageCountCache.keys().next().value;
    if (typeof oldestKey !== "string" || !oldestKey) {
      break;
    }
    transcriptMessageCountCache.delete(oldestKey);
  }
}

async function yieldTranscriptScan(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** Attach OpenClaw metadata to a transcript message without dropping existing metadata. */
export function attachOpenClawTranscriptMeta(
  message: unknown,
  meta: Record<string, unknown>,
): unknown {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return message;
  }
  const record = message as Record<string, unknown>;
  const existing =
    record["__openclaw"] &&
    typeof record["__openclaw"] === "object" &&
    !Array.isArray(record["__openclaw"])
      ? (record["__openclaw"] as Record<string, unknown>)
      : {};
  return {
    ...record,
    __openclaw: {
      ...existing,
      ...meta,
    },
  };
}

function readTranscriptMessageIdempotencyKey(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const value = (message as Record<string, unknown>).idempotencyKey;
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Read all visible transcript messages for a session from the first existing candidate file. */
export function readSessionMessages(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): unknown[] {
  const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
  if (!filePath) {
    return [];
  }

  return transcriptRecordsToMessages(readSelectedTranscriptRecords(filePath));
}

export type ReadRecentSessionMessagesOptions = {
  maxMessages: number;
  maxBytes?: number;
  maxLines?: number;
  allowResetArchiveFallback?: boolean;
  resetArchiveOnly?: boolean;
};

type ReadSessionMessagesPageOptions = {
  offset: number;
  maxMessages: number;
  allowResetArchiveFallback?: boolean;
  resetArchiveOnly?: boolean;
};

export type ReadSessionMessagesAsyncOptions =
  | {
      mode: "full";
      reason: string;
      allowResetArchiveFallback?: boolean;
      resetArchiveOnly?: boolean;
    }
  | ({
      mode: "recent";
    } & ReadRecentSessionMessagesOptions);

export type ReadRecentSessionMessagesResult = {
  messages: unknown[];
  totalMessages: number;
  /** Raw selected transcript rows parsed from the same read as `messages`. */
  transcriptEvents?: TranscriptEvent[];
  transcriptPath?: string;
  transcriptSource?: "active" | "reset-archive";
};

type ReadSessionMessagesResult = {
  messages: unknown[];
  transcriptPath?: string;
};

const RECENT_SESSION_MESSAGES_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

type TailTranscriptRecord = {
  record: Record<string, unknown>;
};

function normalizeRecentSessionReadOptions(opts?: Partial<ReadRecentSessionMessagesOptions>) {
  const maxMessages = resolveNonNegativeIntegerOption(opts?.maxMessages, 0);
  const maxBytes = resolveIntegerOption(opts?.maxBytes, RECENT_SESSION_MESSAGES_DEFAULT_MAX_BYTES, {
    min: 1024,
  });
  const maxLines = resolveIntegerOption(opts?.maxLines, maxMessages * 20 + 20, {
    min: maxMessages,
  });
  return { maxMessages, maxBytes, maxLines };
}

async function readRecentTranscriptTailLinesAsync(
  filePath: string,
  stat: fs.Stats,
  opts: ReadRecentSessionMessagesOptions,
): Promise<string[]> {
  const { maxBytes, maxLines } = normalizeRecentSessionReadOptions(opts);
  const readLen = Math.min(stat.size, maxBytes);
  const readStart = Math.max(0, stat.size - readLen);
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(readLen);
    const bytesRead = await readFileWindowFully(handle, buffer, readStart);
    if (bytesRead <= 0) {
      return [];
    }
    return buffer
      .toString("utf-8", 0, bytesRead)
      .split(/\r?\n/)
      .slice(readStart > 0 ? 1 : 0)
      .filter((line) => line.trim().length > 0)
      .slice(-maxLines);
  } finally {
    await handle.close();
  }
}

const MAX_TRANSCRIPT_PARSE_LINE_BYTES = 256 * 1024;
const OVERSIZED_TRANSCRIPT_METADATA_PREFIX_CHARS = 64 * 1024;
const OVERSIZED_TRANSCRIPT_METADATA_SUFFIX_CHARS = 64 * 1024;
const TRANSCRIPT_OVERSIZED_MESSAGE_PLACEHOLDER = "[chat.history omitted: message too large]";

function isOversizedTranscriptLine(line: string): boolean {
  return Buffer.byteLength(line, "utf8") > MAX_TRANSCRIPT_PARSE_LINE_BYTES;
}

function isJsonObjectFieldToken(source: string, tokenIndex: number): boolean {
  for (let index = tokenIndex - 1; index >= 0; index--) {
    const char = source.charAt(index);
    if (/\s/.test(char)) {
      continue;
    }
    return char === "{" || char === ",";
  }
  return true;
}

function extractJsonStringFieldWindow(
  source: string,
  field: string,
  startIndex = 0,
  endIndex = source.length,
): string | undefined {
  const fieldToken = JSON.stringify(field);
  let searchIndex = startIndex;
  while (searchIndex < endIndex) {
    const tokenIndex = source.indexOf(fieldToken, searchIndex);
    if (tokenIndex < 0 || tokenIndex >= endIndex) {
      return undefined;
    }
    searchIndex = tokenIndex + fieldToken.length;
    if (!isJsonObjectFieldToken(source, tokenIndex)) {
      continue;
    }
    const match = /^\s*:\s*"((?:\\.|[^"\\])*)"/.exec(source.slice(searchIndex, endIndex));
    if (!match) {
      continue;
    }
    try {
      const decoded = JSON.parse(`"${match[1]}"`) as unknown;
      return readNonBlankStringPreservingWhitespace(decoded);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function extractJsonStringFieldSuffix(source: string, field: string): string | undefined {
  const startIndex = Math.max(0, source.length - OVERSIZED_TRANSCRIPT_METADATA_SUFFIX_CHARS);
  return extractJsonStringFieldWindow(source, field, startIndex);
}

function buildOversizedTranscriptRecord(line: string): TailTranscriptRecord {
  const prefix = line.slice(0, OVERSIZED_TRANSCRIPT_METADATA_PREFIX_CHARS);
  const messageMatch = /"message"\s*:/.exec(prefix);
  const recordPrefix = messageMatch ? prefix.slice(0, messageMatch.index) : prefix;
  const id = extractJsonStringFieldPrefix(prefix, "id");
  const parentId = extractJsonNullableStringFieldPrefix(prefix, "parentId");
  const type = extractJsonStringFieldPrefix(prefix, "type");
  const timestamp =
    extractJsonStringFieldPrefix(recordPrefix, "timestamp") ??
    extractJsonNumberFieldPrefix(recordPrefix, "timestamp");
  const role = extractJsonStringFieldPrefix(prefix, "role") ?? "assistant";
  const idempotencyKey =
    extractJsonStringFieldPrefix(prefix, "idempotencyKey") ??
    extractJsonStringFieldSuffix(line, "idempotencyKey");
  const record: Record<string, unknown> = {
    ...(type ? { type } : {}),
    ...(id ? { id } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    message: {
      role,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      content: [{ type: "text", text: TRANSCRIPT_OVERSIZED_MESSAGE_PLACEHOLDER }],
      __openclaw: { truncated: true, reason: "oversized" },
    },
  };
  return { record };
}

function parseTailTranscriptRecord(line: string): TailTranscriptRecord | null {
  if (isOversizedTranscriptLine(line)) {
    return buildOversizedTranscriptRecord(line);
  }
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    return { record };
  } catch {
    return null;
  }
}

function selectBoundedActiveTailRecords(
  entries: TailTranscriptRecord[],
  opts?: { failClosedOnInvalidLeafControl?: boolean },
): TailTranscriptRecord[] {
  return selectSessionTranscriptActiveEntries({
    entries,
    recordOf: (entry) => entry.record,
    failClosedOnInvalidLeafControl: opts?.failClosedOnInvalidLeafControl,
  });
}

function readTranscriptRecords(filePath: string): TailTranscriptRecord[] {
  const records: TailTranscriptRecord[] = [];
  visitTranscriptLines(filePath, (line) => {
    if (!line.trim()) {
      return;
    }
    const record = parseTailTranscriptRecord(line);
    if (record && record.record.type !== "session") {
      records.push(record);
    }
  });
  return records;
}

function selectActiveTranscriptRecords(records: TailTranscriptRecord[]): TailTranscriptRecord[] {
  return selectBoundedActiveTailRecords(records);
}

function readSelectedTranscriptRecords(filePath: string): TailTranscriptRecord[] {
  try {
    return selectActiveTranscriptRecords(readTranscriptRecords(filePath));
  } catch {
    return [];
  }
}

function transcriptRecordsToMessages(records: TailTranscriptRecord[]): unknown[] {
  const messages: unknown[] = [];
  let messageSeq = 0;
  for (const entry of records) {
    const message = parsedSessionEntryToMessage(entry.record, messageSeq + 1);
    if (message) {
      messageSeq += 1;
      messages.push(message);
    }
  }
  return messages;
}

function parseRecentTranscriptTailSnapshot(
  lines: string[],
  maxMessages: number,
): { messages: unknown[]; transcriptEvents: TranscriptEvent[] } {
  const entries = lines.flatMap((line) => {
    const entry = parseTailTranscriptRecord(line);
    return entry ? [entry] : [];
  });
  const selected = selectBoundedActiveTailRecords(entries, {
    failClosedOnInvalidLeafControl: true,
  });
  return {
    messages: transcriptRecordsToMessages(selected).slice(-maxMessages),
    transcriptEvents: selected.map((entry) => entry.record),
  };
}

function visitTranscriptLines(filePath: string, visit: (line: string) => void): void {
  const fd = fs.openSync(filePath, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let carry = "";
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) {
        break;
      }
      const text = carry + decoder.write(buffer.subarray(0, bytesRead));
      const lines = text.split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const line of lines) {
        visit(line);
      }
    }
    const tail = carry + decoder.end();
    if (tail) {
      visit(tail);
    }
  } finally {
    fs.closeSync(fd);
  }
}

async function visitTranscriptLinesAsync(
  filePath: string,
  visit: (line: string) => void,
): Promise<void> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(TRANSCRIPT_ASYNC_READ_CHUNK_BYTES);
    let carry = "";
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead <= 0) {
        break;
      }
      const text = carry + decoder.write(buffer.subarray(0, bytesRead));
      const lines = text.split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const line of lines) {
        visit(line);
      }
      await yieldTranscriptScan();
    }
    const tail = carry + decoder.end();
    if (tail) {
      visit(tail);
    }
  } finally {
    await handle.close();
  }
}

export async function readSessionMessagesAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  opts: ReadSessionMessagesAsyncOptions,
  agentId?: string,
): Promise<unknown[]> {
  const result = await readSessionMessagesWithSourceAsync(
    sessionId,
    storePath,
    sessionFile,
    opts,
    agentId,
  );
  return result.messages;
}

export async function readSessionMessagesWithSourceAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  opts: ReadSessionMessagesAsyncOptions,
  agentId?: string,
): Promise<ReadSessionMessagesResult> {
  if (opts.mode === "recent") {
    const { mode: _modeValue, ...recentOpts } = opts;
    const result = await readRecentSessionMessagesWithSourceAsync(
      sessionId,
      storePath,
      sessionFile,
      recentOpts,
      agentId,
    );
    return result;
  }
  const filePath =
    opts.allowResetArchiveFallback === true
      ? await findExistingTranscriptHistoryPathAsync(sessionId, storePath, sessionFile, agentId, {
          resetArchiveOnly: opts.resetArchiveOnly === true,
        })
      : findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
  if (!filePath) {
    return { messages: [] };
  }
  const index = await readSessionTranscriptIndex(filePath);
  return {
    messages: index?.entries.flatMap((entry) => indexedTranscriptEntryToMessages(entry)) ?? [],
    transcriptPath: filePath,
  };
}

export async function readSessionMessageByIdAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  messageId: string,
  opts?: { allowResetArchiveFallback?: boolean; agentId?: string; resetArchiveOnly?: boolean },
): Promise<{ message?: unknown; seq?: number; oversized: boolean; found: boolean }> {
  const filePath =
    opts?.allowResetArchiveFallback === true
      ? await findExistingTranscriptHistoryPathAsync(
          sessionId,
          storePath,
          sessionFile,
          opts.agentId,
          { resetArchiveOnly: opts.resetArchiveOnly === true },
        )
      : findExistingTranscriptPath(sessionId, storePath, sessionFile, opts?.agentId);
  if (!filePath) {
    return { oversized: false, found: false };
  }
  const index = await readSessionTranscriptIndex(filePath);
  if (!index) {
    return { oversized: false, found: false };
  }
  const entry = index.entries.find((candidate) => candidate.id === messageId);
  if (!entry) {
    return { oversized: false, found: false };
  }
  if (entry.byteLength > MAX_TRANSCRIPT_PARSE_LINE_BYTES) {
    return { oversized: true, found: true, seq: entry.seq };
  }
  const message = indexedTranscriptEntryToMessage(entry);
  return { message, seq: entry.seq, oversized: false, found: true };
}

export async function visitSessionMessagesAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  visit: (message: unknown, seq: number) => void,
  opts: { mode: "full"; reason: string; cache?: "reuse" | "skip" },
  agentId?: string,
): Promise<number> {
  const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
  if (!filePath) {
    return 0;
  }
  const index = await readSessionTranscriptIndex(filePath, { cache: opts.cache });
  if (!index) {
    return 0;
  }
  for (const entry of index.entries) {
    const message = indexedTranscriptEntryToMessage(entry);
    if (message) {
      visit(message, entry.seq);
    }
  }
  return index.entries.length;
}

export async function readSessionMessageCountAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): Promise<number> {
  const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
  if (!filePath) {
    return 0;
  }
  return await readSessionMessageCountFromPathAsync(filePath);
}

export async function readRecentSessionMessagesAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  opts?: ReadRecentSessionMessagesOptions,
  agentId?: string,
): Promise<unknown[]> {
  const result = await readRecentSessionMessagesWithSourceAsync(
    sessionId,
    storePath,
    sessionFile,
    opts,
    agentId,
  );
  return result.messages;
}

async function readRecentSessionMessagesWithSourceAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  opts?: ReadRecentSessionMessagesOptions,
  agentId?: string,
): Promise<ReadSessionMessagesResult> {
  const normalized = normalizeRecentSessionReadOptions(opts);
  const { maxMessages } = normalized;
  if (maxMessages === 0) {
    return { messages: [] };
  }

  const filePath =
    opts?.allowResetArchiveFallback === true
      ? await findExistingTranscriptHistoryPathAsync(sessionId, storePath, sessionFile, agentId, {
          resetArchiveOnly: opts.resetArchiveOnly === true,
        })
      : findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
  if (!filePath) {
    return { messages: [] };
  }
  return {
    messages: await readRecentSessionMessagesFromPathAsync(filePath, normalized),
    transcriptPath: filePath,
  };
}

async function readRecentSessionMessagesFromPathAsync(
  filePath: string,
  opts: ReturnType<typeof normalizeRecentSessionReadOptions>,
): Promise<unknown[]> {
  return (await readRecentSessionSnapshotFromPathAsync(filePath, opts)).messages;
}

async function readRecentSessionSnapshotFromPathAsync(
  filePath: string,
  opts: ReturnType<typeof normalizeRecentSessionReadOptions>,
): Promise<{ messages: unknown[]; transcriptEvents: TranscriptEvent[] }> {
  const { maxMessages } = opts;

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return { messages: [], transcriptEvents: [] };
  }
  if (stat.size === 0) {
    return { messages: [], transcriptEvents: [] };
  }
  const lines = await readRecentTranscriptTailLinesAsync(filePath, stat, {
    ...opts,
  });
  return parseRecentTranscriptTailSnapshot(lines, maxMessages);
}

export async function readRecentSessionMessagesWithStatsAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  opts: ReadRecentSessionMessagesOptions,
  agentId?: string,
): Promise<ReadRecentSessionMessagesResult> {
  const filePath =
    opts.allowResetArchiveFallback === true
      ? await findExistingTranscriptHistoryPathAsync(sessionId, storePath, sessionFile, agentId, {
          resetArchiveOnly: opts.resetArchiveOnly === true,
        })
      : findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
  if (!filePath) {
    return { messages: [], totalMessages: 0 };
  }
  const transcriptSource =
    opts.allowResetArchiveFallback === true &&
    findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId) !== filePath
      ? "reset-archive"
      : "active";
  const totalMessages = await readSessionMessageCountFromPathAsync(filePath);
  const snapshot = await readRecentSessionSnapshotFromPathAsync(
    filePath,
    normalizeRecentSessionReadOptions(opts),
  );
  const firstSeq = Math.max(1, totalMessages - snapshot.messages.length + 1);
  const messagesWithSeq = snapshot.messages.map((message, index) =>
    attachOpenClawTranscriptMeta(message, { seq: firstSeq + index }),
  );
  return {
    messages: messagesWithSeq,
    transcriptEvents: snapshot.transcriptEvents,
    totalMessages,
    transcriptPath: filePath,
    transcriptSource,
  };
}

export async function readSessionMessagesPageWithStatsAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  opts: ReadSessionMessagesPageOptions,
  agentId?: string,
): Promise<ReadRecentSessionMessagesResult> {
  const filePath =
    opts.allowResetArchiveFallback === true
      ? await findExistingTranscriptHistoryPathAsync(sessionId, storePath, sessionFile, agentId)
      : findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
  if (!filePath) {
    return { messages: [], totalMessages: 0 };
  }
  const transcriptSource =
    opts.allowResetArchiveFallback === true &&
    findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId) !== filePath
      ? "reset-archive"
      : "active";
  const index = await readSessionTranscriptIndex(filePath);
  if (!index) {
    return { messages: [], totalMessages: 0, transcriptPath: filePath };
  }
  const totalMessages = index.entries.length;
  const offset = Math.min(resolveNonNegativeIntegerOption(opts.offset, 0), totalMessages);
  const maxMessages = resolveNonNegativeIntegerOption(opts.maxMessages, 0);
  const endExclusive = Math.max(0, totalMessages - offset);
  const start = Math.max(0, endExclusive - maxMessages);
  return {
    messages: index.entries
      .slice(start, endExclusive)
      .flatMap((entry) => indexedTranscriptEntryToMessages(entry)),
    transcriptEvents: index.entries.slice(start, endExclusive).map((entry) => entry.record),
    totalMessages,
    transcriptPath: filePath,
    transcriptSource,
  };
}

function parsedSessionEntryToMessage(parsed: unknown, seq: number): unknown {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const entry = parsed as Record<string, unknown>;
  if (entry.message) {
    const recordTimestampMs =
      typeof entry.timestamp === "string"
        ? Date.parse(entry.timestamp)
        : typeof entry.timestamp === "number"
          ? entry.timestamp
          : Number.NaN;
    const idempotencyKey = readTranscriptMessageIdempotencyKey(entry.message);
    return attachOpenClawTranscriptMeta(entry.message, {
      ...(typeof entry.id === "string" ? { id: entry.id } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(Number.isFinite(recordTimestampMs) ? { recordTimestampMs } : {}),
      seq,
    });
  }

  // Compaction entries are not "message" records, but they're useful context for debugging.
  // Emit a lightweight synthetic message that the Web UI can render as a divider.
  if (entry.type === "compaction") {
    const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
    const timestamp = Number.isFinite(ts) ? ts : Date.now();
    return {
      role: "system",
      content: [{ type: "text", text: "Compaction" }],
      timestamp,
      __openclaw: {
        kind: "compaction",
        id: typeof entry.id === "string" ? entry.id : undefined,
        seq,
      },
    };
  }
  return null;
}

function indexedTranscriptEntryToMessage(entry: IndexedTranscriptEntry): unknown {
  return parsedSessionEntryToMessage(entry.record, entry.seq);
}

export function indexedTranscriptEntryToMessages(entry: IndexedTranscriptEntry): unknown[] {
  const message = indexedTranscriptEntryToMessage(entry);
  return message ? [message] : [];
}

export { resolveSessionTranscriptCandidates } from "./session-transcript-files.fs.js";

export function capArrayByJsonBytes<T>(
  items: T[],
  maxBytes: number,
): { items: T[]; bytes: number } {
  if (items.length === 0) {
    return { items, bytes: 2 };
  }
  const parts = items.map((item) => jsonUtf8Bytes(item));
  let bytes = 2 + parts.reduce((a, b) => a + b, 0) + (items.length - 1);
  let start = 0;
  while (bytes > maxBytes && start < items.length - 1) {
    bytes -= expectDefined(parts[start], "parts entry at start") + 1;
    start += 1;
  }
  const next = start > 0 ? items.slice(start) : items;
  return { items: next, bytes };
}

const MAX_LINES_TO_SCAN = 10;

type TranscriptMessage = {
  role?: string;
  content?: string | Array<{ type: string; text?: string }>;
  provenance?: unknown;
};

export function readSessionTitleFieldsFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
  opts?: { includeInterSession?: boolean },
): SessionTitleFields {
  const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
  if (!filePath) {
    return { firstUserMessage: null, lastMessagePreview: null };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { firstUserMessage: null, lastMessagePreview: null };
  }

  const cacheKey = readSessionTitleFieldsCacheKey(filePath, opts);
  const cached = getCachedSessionTitleFields(cacheKey, stat);
  if (cached) {
    return cached;
  }

  if (stat.size === 0) {
    const empty = { firstUserMessage: null, lastMessagePreview: null };
    setCachedSessionTitleFields(cacheKey, stat, empty);
    return empty;
  }

  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const size = stat.size;

    // Head (first user message)
    let firstUserMessage: string | null = null;
    try {
      const chunk = readTranscriptHeadChunk(fd);
      if (chunk) {
        firstUserMessage = extractFirstUserMessageFromTranscriptChunk(chunk, opts);
      }
    } catch {
      // ignore head read errors
    }

    // Tail (last message preview)
    let lastMessagePreview: string | null = null;
    try {
      lastMessagePreview = readLastMessagePreviewFromOpenTranscript({ fd, size });
    } catch {
      // ignore tail read errors
    }

    const result = { firstUserMessage, lastMessagePreview };
    setCachedSessionTitleFields(cacheKey, stat, result);
    return result;
  } catch {
    return { firstUserMessage: null, lastMessagePreview: null };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export async function readSessionTitleFieldsFromTranscriptAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
  opts?: { includeInterSession?: boolean },
): Promise<SessionTitleFields> {
  const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
  if (!filePath) {
    return { firstUserMessage: null, lastMessagePreview: null };
  }
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return { firstUserMessage: null, lastMessagePreview: null };
  }
  const cacheKey = readSessionTitleFieldsCacheKey(filePath, opts);
  const cached = getCachedSessionTitleFields(cacheKey, stat);
  if (cached) {
    return cached;
  }

  if (stat.size === 0) {
    const empty = { firstUserMessage: null, lastMessagePreview: null };
    setCachedSessionTitleFields(cacheKey, stat, empty);
    return empty;
  }

  let handle: TranscriptFileHandle | null = null;
  try {
    handle = await fs.promises.open(filePath, "r");

    let firstUserMessage: string | null = null;
    try {
      const chunk = await readTranscriptHeadChunkAsync(handle);
      if (chunk) {
        firstUserMessage = extractFirstUserMessageFromTranscriptChunk(chunk, opts);
      }
    } catch {
      // ignore head read errors
    }

    let lastMessagePreview: string | null = null;
    try {
      lastMessagePreview = await readLastMessagePreviewFromOpenTranscriptAsync({
        handle,
        size: stat.size,
      });
    } catch {
      // ignore tail read errors
    }

    const result = { firstUserMessage, lastMessagePreview };
    setCachedSessionTitleFields(cacheKey, stat, result);
    return result;
  } catch {
    return { firstUserMessage: null, lastMessagePreview: null };
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
  }
}

function extractTextFromContent(content: TranscriptMessage["content"]): string | null {
  if (typeof content === "string") {
    const normalized = stripInlineDirectiveTagsForDisplay(content).text.trim();
    return normalized || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  for (const part of content) {
    if (!part || typeof part.text !== "string") {
      continue;
    }
    if (part.type === "text" || part.type === "output_text" || part.type === "input_text") {
      const normalized = stripInlineDirectiveTagsForDisplay(part.text).text.trim();
      if (normalized) {
        return normalized;
      }
    }
  }
  return null;
}

function readTranscriptHeadChunk(fd: number, maxBytes = 8192): string | null {
  const buf = Buffer.alloc(maxBytes);
  const bytesRead = readFileWindowFullySync(fd, buf, 0);
  if (bytesRead <= 0) {
    return null;
  }
  return buf.toString("utf-8", 0, bytesRead);
}

async function readTranscriptHeadChunkAsync(
  handle: TranscriptFileHandle,
  maxBytes = 8192,
): Promise<string | null> {
  const buffer = Buffer.alloc(maxBytes);
  const bytesRead = await readFileWindowFully(handle, buffer, 0);
  if (bytesRead <= 0) {
    return null;
  }
  return buffer.toString("utf-8", 0, bytesRead);
}

function extractFirstUserMessageFromTranscriptChunk(
  chunk: string,
  opts?: { includeInterSession?: boolean },
): string | null {
  const lines = chunk.split(/\r?\n/).slice(0, MAX_LINES_TO_SCAN);
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      const msg = parsed?.message as TranscriptMessage | undefined;
      if (msg?.role !== "user") {
        continue;
      }
      if (opts?.includeInterSession !== true && hasInterSessionUserProvenance(msg)) {
        continue;
      }
      const text = extractTextFromContent(msg.content);
      if (text) {
        return text;
      }
    } catch {
      // skip malformed lines
    }
  }
  return null;
}

export function findExistingTranscriptPath(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): string | null {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

async function findExistingTranscriptHistoryPathAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
  opts?: { resetArchiveOnly?: boolean },
): Promise<string | null> {
  if (opts?.resetArchiveOnly !== true) {
    const activePath = findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
    if (activePath) {
      return activePath;
    }
  }
  for (const archivePath of await resolveSessionTranscriptResetArchiveCandidatesAsync(
    sessionId,
    storePath,
    sessionFile,
    agentId,
  )) {
    const stat = await fs.promises.stat(archivePath).catch(() => null);
    if (stat?.isFile()) {
      if (opts?.resetArchiveOnly !== true) {
        const refreshedActivePath = findExistingTranscriptPath(
          sessionId,
          storePath,
          sessionFile,
          agentId,
        );
        if (refreshedActivePath) {
          return refreshedActivePath;
        }
      }
      // Compressed archives materialize to a plain JSONL cache once (archives
      // are write-once) so every downstream reader — index, tail chunks,
      // header probes — keeps working without knowing about zstd.
      try {
        return materializeSessionArchiveForRead(archivePath);
      } catch {
        continue;
      }
    }
  }
  return null;
}

export async function resolveSessionHistoryTranscriptPathAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  opts?: { agentId?: string; allowResetArchiveFallback?: boolean },
): Promise<string | null> {
  return opts?.allowResetArchiveFallback === true
    ? findExistingTranscriptHistoryPathAsync(sessionId, storePath, sessionFile, opts.agentId)
    : findExistingTranscriptPath(sessionId, storePath, sessionFile, opts?.agentId);
}

async function readSessionMessageCountFromPathAsync(filePath: string): Promise<number> {
  let stat: fs.Stats | null = null;
  try {
    stat = await fs.promises.stat(filePath);
    const cached = getCachedTranscriptMessageCount(filePath, stat);
    if (typeof cached === "number") {
      return cached;
    }
  } catch {
    // Count from the transcript index below when stat metadata is unavailable.
  }
  const index = await readSessionTranscriptIndex(filePath);
  const count = index?.entries.length ?? 0;
  if (stat) {
    setCachedTranscriptMessageCount(filePath, stat, count);
  }
  return count;
}

function withOpenTranscriptFd<T>(filePath: string, read: (fd: number) => T | null): T | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    return read(fd);
  } catch {
    // file read error
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
  return null;
}

const LAST_MSG_MAX_BYTES = 16384;
const LAST_MSG_MAX_LINES = 20;

function extractLastMessagePreviewFromTranscriptLines(lines: string[]): string | null {
  const records = lines.flatMap((line) => {
    const parsed = parseTailTranscriptRecord(line);
    return parsed ? [parsed] : [];
  });
  const selected = selectBoundedActiveTailRecords(records, {
    failClosedOnInvalidLeafControl: true,
  });
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const msg = selected[index]?.record.message as TranscriptMessage | undefined;
    if (msg?.role !== "user" && msg?.role !== "assistant") {
      continue;
    }
    const text = extractTextFromContent(msg.content);
    if (text) {
      return text;
    }
  }
  return null;
}

function readLastMessagePreviewFromOpenTranscript(params: {
  fd: number;
  size: number;
}): string | null {
  const readStart = Math.max(0, params.size - LAST_MSG_MAX_BYTES);
  const readLen = Math.min(params.size, LAST_MSG_MAX_BYTES);
  const buf = Buffer.alloc(readLen);
  const bytesRead = readFileWindowFullySync(params.fd, buf, readStart);
  if (bytesRead <= 0) {
    return null;
  }

  const chunk = buf.toString("utf-8", 0, bytesRead);
  const lines = chunk.split(/\r?\n/).filter((l) => l.trim());
  return extractLastMessagePreviewFromTranscriptLines(lines.slice(-LAST_MSG_MAX_LINES));
}

async function readLastMessagePreviewFromOpenTranscriptAsync(params: {
  handle: TranscriptFileHandle;
  size: number;
}): Promise<string | null> {
  const readStart = Math.max(0, params.size - LAST_MSG_MAX_BYTES);
  const readLen = Math.min(params.size, LAST_MSG_MAX_BYTES);
  const buffer = Buffer.alloc(readLen);
  const bytesRead = await readFileWindowFully(params.handle, buffer, readStart);
  if (bytesRead <= 0) {
    return null;
  }

  const chunk = buffer.toString("utf-8", 0, bytesRead);
  const lines = chunk.split(/\r?\n/).filter((line) => line.trim());
  return extractLastMessagePreviewFromTranscriptLines(lines.slice(-LAST_MSG_MAX_LINES));
}

export type SessionTranscriptUsageSnapshot = {
  modelProvider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  contextUsage?: ContextUsage;
  trailingBytes?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  costUsd?: number;
};

function extractTranscriptUsageCost(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const cost = (raw as { cost?: unknown }).cost;
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) {
    return undefined;
  }
  const total = (cost as { total?: unknown }).total;
  return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : undefined;
}

function resolvePositiveUsageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function extractTranscriptContentEstimatedChars(content: unknown): number {
  if (typeof content === "string") {
    const normalized = stripInlineDirectiveTagsForDisplay(content).text.trim();
    return normalized ? estimateStringChars(normalized) : 0;
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  let chars = 0;
  for (const part of content) {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      continue;
    }
    const record = part as Record<string, unknown>;
    if (typeof record.text !== "string") {
      continue;
    }
    const type = typeof record.type === "string" ? record.type : "text";
    if (type !== "text" && type !== "output_text" && type !== "input_text") {
      continue;
    }
    const normalized = stripInlineDirectiveTagsForDisplay(record.text).text.trim();
    if (normalized) {
      chars += estimateStringChars(normalized);
    }
  }
  return chars;
}

function extractTranscriptTokenEstimateFromLine(line: string): {
  estimatedChars: number;
  hasModelIdentity: boolean;
} | null {
  if (isOversizedTranscriptLine(line)) {
    return null;
  }
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const message =
      parsed.message && typeof parsed.message === "object" && !Array.isArray(parsed.message)
        ? (parsed.message as Record<string, unknown>)
        : undefined;
    if (!message) {
      return null;
    }
    const role = typeof message.role === "string" ? message.role : undefined;
    if (role !== "user" && role !== "assistant") {
      return null;
    }
    const modelProvider =
      typeof message.provider === "string"
        ? message.provider.trim()
        : typeof parsed.provider === "string"
          ? parsed.provider.trim()
          : undefined;
    const model =
      typeof message.model === "string"
        ? message.model.trim()
        : typeof parsed.model === "string"
          ? parsed.model.trim()
          : undefined;
    const isDeliveryMirror =
      role === "assistant" && modelProvider === "openclaw" && model === "delivery-mirror";
    if (isDeliveryMirror) {
      return null;
    }
    const contentChars = extractTranscriptContentEstimatedChars(message.content);
    if (contentChars <= 0) {
      return null;
    }
    return {
      estimatedChars: contentChars,
      hasModelIdentity: role === "assistant" && Boolean(modelProvider || model),
    };
  } catch {
    return null;
  }
}

function extractUsageSnapshotFromTranscriptLine(
  line: string,
): SessionTranscriptUsageSnapshot | null {
  if (isOversizedTranscriptLine(line)) {
    return null;
  }
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const message =
      parsed.message && typeof parsed.message === "object" && !Array.isArray(parsed.message)
        ? (parsed.message as Record<string, unknown>)
        : undefined;
    if (!message) {
      return null;
    }
    const role = typeof message.role === "string" ? message.role : undefined;
    if (role && role !== "assistant") {
      return null;
    }
    const usageRaw =
      message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
        ? message.usage
        : parsed.usage && typeof parsed.usage === "object" && !Array.isArray(parsed.usage)
          ? parsed.usage
          : undefined;
    const usage = normalizeUsage(usageRaw);
    const totalTokens = resolvePositiveUsageNumber(deriveSessionTotalTokens({ usage }));
    const costUsd = extractTranscriptUsageCost(usageRaw);
    const modelProvider =
      typeof message.provider === "string"
        ? message.provider.trim()
        : typeof parsed.provider === "string"
          ? parsed.provider.trim()
          : undefined;
    const model =
      typeof message.model === "string"
        ? message.model.trim()
        : typeof parsed.model === "string"
          ? parsed.model.trim()
          : undefined;
    const isDeliveryMirror = modelProvider === "openclaw" && model === "delivery-mirror";
    const hasMeaningfulUsage =
      hasNonzeroUsage(usage) ||
      typeof totalTokens === "number" ||
      (typeof costUsd === "number" && Number.isFinite(costUsd));
    const hasModelIdentity = Boolean(modelProvider || model);
    if (!hasMeaningfulUsage && !hasModelIdentity) {
      return null;
    }
    if (isDeliveryMirror && !hasMeaningfulUsage) {
      return null;
    }

    const snapshot: SessionTranscriptUsageSnapshot = {};
    if (!isDeliveryMirror) {
      if (modelProvider) {
        snapshot.modelProvider = modelProvider;
      }
      if (model) {
        snapshot.model = model;
      }
    }
    if (typeof usage?.input === "number" && Number.isFinite(usage.input)) {
      snapshot.inputTokens = usage.input;
    }
    if (typeof usage?.output === "number" && Number.isFinite(usage.output)) {
      snapshot.outputTokens = usage.output;
    }
    if (typeof usage?.cacheRead === "number" && Number.isFinite(usage.cacheRead)) {
      snapshot.cacheRead = usage.cacheRead;
    }
    if (typeof usage?.cacheWrite === "number" && Number.isFinite(usage.cacheWrite)) {
      snapshot.cacheWrite = usage.cacheWrite;
    }
    if (usage?.contextUsage) {
      snapshot.contextUsage = usage.contextUsage;
    }
    if (typeof totalTokens === "number") {
      snapshot.totalTokens = totalTokens;
      snapshot.totalTokensFresh = true;
    }
    if (typeof costUsd === "number" && Number.isFinite(costUsd)) {
      snapshot.costUsd = costUsd;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function extractAggregateUsageFromTranscriptLines(
  lines: Iterable<string>,
): SessionTranscriptUsageSnapshot | null {
  const snapshot: SessionTranscriptUsageSnapshot = {};
  let sawSnapshot = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let sawInputTokens = false;
  let sawOutputTokens = false;
  let sawCacheRead = false;
  let sawCacheWrite = false;
  let costUsdTotal = 0;
  let sawCost = false;
  let estimatedTranscriptChars = 0;
  let sawEstimatedTranscriptContent = false;
  let sawEstimateModelIdentity = false;

  for (const line of lines) {
    const estimate = extractTranscriptTokenEstimateFromLine(line);
    if (estimate) {
      estimatedTranscriptChars += estimate.estimatedChars;
      sawEstimatedTranscriptContent = true;
      sawEstimateModelIdentity ||= estimate.hasModelIdentity;
    }
    const current = extractUsageSnapshotFromTranscriptLine(line);
    if (!current) {
      continue;
    }
    sawSnapshot = true;
    if (current.modelProvider) {
      snapshot.modelProvider = current.modelProvider;
    }
    if (current.model) {
      snapshot.model = current.model;
    }
    if (typeof current.inputTokens === "number") {
      inputTokens += current.inputTokens;
      sawInputTokens = true;
    }
    if (typeof current.outputTokens === "number") {
      outputTokens += current.outputTokens;
      sawOutputTokens = true;
    }
    if (typeof current.cacheRead === "number") {
      cacheRead += current.cacheRead;
      sawCacheRead = true;
    }
    if (typeof current.cacheWrite === "number") {
      cacheWrite += current.cacheWrite;
      sawCacheWrite = true;
    }
    if (current.contextUsage) {
      snapshot.contextUsage = current.contextUsage;
    } else {
      delete snapshot.contextUsage;
    }
    if (current.contextUsage?.state === "unavailable") {
      delete snapshot.totalTokens;
      delete snapshot.totalTokensFresh;
    } else if (typeof current.totalTokens === "number") {
      snapshot.totalTokens = current.totalTokens;
      snapshot.totalTokensFresh = true;
    }
    if (typeof current.costUsd === "number" && Number.isFinite(current.costUsd)) {
      costUsdTotal += current.costUsd;
      sawCost = true;
    }
  }

  if (!sawSnapshot) {
    return null;
  }
  if (sawInputTokens) {
    snapshot.inputTokens = inputTokens;
  }
  if (sawOutputTokens) {
    snapshot.outputTokens = outputTokens;
  }
  if (sawCacheRead) {
    snapshot.cacheRead = cacheRead;
  }
  if (sawCacheWrite) {
    snapshot.cacheWrite = cacheWrite;
  }
  if (sawCost) {
    snapshot.costUsd = costUsdTotal;
  }
  if (
    typeof snapshot.totalTokens !== "number" &&
    sawEstimatedTranscriptContent &&
    sawEstimateModelIdentity
  ) {
    const estimatedTotalTokens = estimateTokensFromChars(estimatedTranscriptChars);
    if (estimatedTotalTokens > 0) {
      snapshot.totalTokens = estimatedTotalTokens;
      snapshot.totalTokensFresh = true;
    }
  }
  return snapshot;
}

function extractAggregateUsageFromTranscriptChunk(
  chunk: string,
): SessionTranscriptUsageSnapshot | null {
  return extractAggregateUsageFromTranscriptLines(
    chunk.split(/\r?\n/).filter((line) => line.trim().length > 0),
  );
}

export async function readLatestSessionUsageFromTranscriptAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): Promise<SessionTranscriptUsageSnapshot | null> {
  const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
  if (!filePath) {
    return null;
  }

  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size === 0) {
      return null;
    }
    const lines: string[] = [];
    await visitTranscriptLinesAsync(filePath, (line) => {
      if (line.trim()) {
        lines.push(line);
      }
    });
    return extractAggregateUsageFromTranscriptLines(lines);
  } catch {
    return null;
  }
}

export function readRecentSessionUsageFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  agentId: string | undefined,
  maxBytes: number,
): SessionTranscriptUsageSnapshot | null {
  const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
  if (!filePath) {
    return null;
  }

  return withOpenTranscriptFd(filePath, (fd) => {
    const stat = fs.fstatSync(fd);
    if (stat.size === 0) {
      return null;
    }
    const readLen = Math.min(stat.size, Math.max(1024, Math.floor(maxBytes)));
    const readStart = Math.max(0, stat.size - readLen);
    const buf = Buffer.alloc(readLen);
    const bytesRead = readFileWindowFullySync(fd, buf, readStart);
    if (bytesRead <= 0) {
      return null;
    }
    const chunk = buf
      .toString("utf-8", 0, bytesRead)
      .split(/\r?\n/)
      .slice(readStart > 0 ? 1 : 0)
      .join("\n");
    return extractAggregateUsageFromTranscriptChunk(chunk);
  });
}

const PREVIEW_READ_SIZES = [64 * 1024, 256 * 1024, 1024 * 1024];
const PREVIEW_MAX_LINES = 200;

type TranscriptContentEntry = {
  type?: string;
  text?: string;
  name?: string;
};

type TranscriptPreviewMessage = {
  role?: string;
  content?: string | TranscriptContentEntry[];
  text?: string;
  toolName?: string;
  tool_name?: string;
};

function normalizeRole(role: string | undefined, isTool: boolean): SessionPreviewItem["role"] {
  if (isTool) {
    return "tool";
  }
  switch (normalizeLowercaseStringOrEmpty(role)) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "system":
      return "system";
    case "tool":
      return "tool";
    default:
      return "other";
  }
}

function truncatePreviewText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  // The preview entry point clamps maxChars to at least 20, so the suffix budget stays positive.
  return `${truncateUtf16Safe(text, maxChars - 3)}...`;
}

function extractPreviewText(message: TranscriptPreviewMessage): string | null {
  const role = normalizeLowercaseStringOrEmpty(message.role);
  if (role === "assistant") {
    const assistantText = extractAssistantVisibleText(message);
    if (assistantText) {
      const normalized = stripInlineDirectiveTagsForDisplay(assistantText).text.trim();
      return normalized ? normalized : null;
    }
    return null;
  }
  if (typeof message.content === "string") {
    const normalized = stripInlineDirectiveTagsForDisplay(message.content).text.trim();
    return normalized ? normalized : null;
  }
  if (Array.isArray(message.content)) {
    const parts = message.content
      .map((entry) =>
        typeof entry?.text === "string" ? stripInlineDirectiveTagsForDisplay(entry.text).text : "",
      )
      .filter((text) => text.trim().length > 0);
    if (parts.length > 0) {
      return parts.join("\n").trim();
    }
  }
  if (typeof message.text === "string") {
    const normalized = stripInlineDirectiveTagsForDisplay(message.text).text.trim();
    return normalized ? normalized : null;
  }
  return null;
}

function isToolCall(message: TranscriptPreviewMessage): boolean {
  return hasToolCall(message as Record<string, unknown>);
}

function extractToolNames(message: TranscriptPreviewMessage): string[] {
  return extractToolCallNames(message as Record<string, unknown>);
}

function extractMediaSummary(message: TranscriptPreviewMessage): string | null {
  if (!Array.isArray(message.content)) {
    return null;
  }
  for (const entry of message.content) {
    const raw = normalizeLowercaseStringOrEmpty(entry?.type);
    if (!raw || raw === "text" || raw === "toolcall" || raw === "tool_call") {
      continue;
    }
    return `[${raw}]`;
  }
  return null;
}

export function buildSessionPreviewItems(
  messages: readonly unknown[],
  maxItems: number,
  maxChars: number,
): SessionPreviewItem[] {
  const items: SessionPreviewItem[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const previewMessage = message as TranscriptPreviewMessage;
    const toolCall = isToolCall(previewMessage);
    const role = normalizeRole(previewMessage.role, toolCall);
    let text = extractPreviewText(previewMessage);
    if (!text) {
      const toolNames = extractToolNames(previewMessage);
      if (toolNames.length > 0) {
        const shown = toolNames.slice(0, 2);
        const overflow = toolNames.length - shown.length;
        text = `call ${shown.join(", ")}`;
        if (overflow > 0) {
          text += ` +${overflow}`;
        }
      }
    }
    if (!text) {
      text = extractMediaSummary(previewMessage);
    }
    if (!text) {
      continue;
    }
    let trimmed = text.trim();
    if (!trimmed) {
      continue;
    }
    if (role === "user") {
      trimmed = stripEnvelope(trimmed);
    }
    trimmed = truncatePreviewText(trimmed, maxChars);
    items.push({ role, text: trimmed });
  }

  if (items.length <= maxItems) {
    return items;
  }
  return items.slice(-maxItems);
}

function readRecentMessagesFromTranscript(
  filePath: string,
  maxMessages: number,
  readBytes: number,
): TranscriptPreviewMessage[] {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    if (size === 0) {
      return [];
    }

    const readStart = Math.max(0, size - readBytes);
    const readLen = Math.min(size, readBytes);
    const buf = Buffer.alloc(readLen);
    const bytesRead = readFileWindowFullySync(fd, buf, readStart);

    const chunk = buf.toString("utf-8", 0, bytesRead);
    const lines = chunk.split(/\r?\n/).filter((l) => l.trim());
    const tailLines = lines.slice(-PREVIEW_MAX_LINES);

    const collected: TranscriptPreviewMessage[] = [];
    for (let i = tailLines.length - 1; i >= 0; i--) {
      const line = expectDefined(tailLines[i], "tail lines entry at i");
      try {
        const parsed = JSON.parse(line);
        const msg = parsed?.message as TranscriptPreviewMessage | undefined;
        if (msg && typeof msg === "object") {
          collected.push(msg);
          if (collected.length >= maxMessages) {
            break;
          }
        }
      } catch {
        // skip malformed lines
      }
    }
    return collected.toReversed();
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
}

export function readSessionPreviewItemsFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  agentId: string | undefined,
  maxItems: number,
  maxChars: number,
): SessionPreviewItem[] {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId);
  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) {
    return [];
  }

  const boundedItems = Math.max(1, Math.min(maxItems, 50));
  const boundedChars = Math.max(20, Math.min(maxChars, 2000));

  for (const readSize of PREVIEW_READ_SIZES) {
    const messages = readRecentMessagesFromTranscript(filePath, boundedItems, readSize);
    if (messages.length > 0 || readSize === PREVIEW_READ_SIZES[PREVIEW_READ_SIZES.length - 1]) {
      return buildSessionPreviewItems(messages, boundedItems, boundedChars);
    }
  }

  return [];
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
