import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { deriveSessionTotalTokens, hasNonzeroUsage, normalizeUsage } from "../agents/usage.js";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import { hasInterSessionUserProvenance } from "../sessions/input-provenance.js";
import { extractAssistantVisibleText } from "../shared/chat-message-content.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import { extractToolCallNames, hasToolCall } from "../utils/transcript-tools.js";
import { stripEnvelope } from "./chat-sanitize.js";
import { resolveSessionTranscriptCandidates } from "./session-transcript-files.fs.js";
import {
  readSessionTranscriptIndex,
  type IndexedTranscriptEntry,
} from "./session-transcript-index.fs.js";
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
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export function attachOpenClawTranscriptMeta(
  message: unknown,
  meta: Record<string, unknown>,
): unknown {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return message;
  }
  const record = message as Record<string, unknown>;
  const existing =
    record.__openclaw && typeof record.__openclaw === "object" && !Array.isArray(record.__openclaw)
      ? (record.__openclaw as Record<string, unknown>)
      : {};
  return {
    ...record,
    __openclaw: {
      ...existing,
      ...meta,
    },
  };
}

export function readSessionMessages(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
): unknown[] {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile);

  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) {
    return [];
  }

  return transcriptRecordsToMessages(readSelectedTranscriptRecords(filePath));
}

export type ReadRecentSessionMessagesOptions = {
  maxMessages: number;
  maxBytes?: number;
  maxLines?: number;
};

export type ReadSessionMessagesAsyncOptions =
  | {
      mode: "full";
      reason: string;
    }
  | ({
      mode: "recent";
    } & ReadRecentSessionMessagesOptions);

type ReadRecentSessionMessagesResult = {
  messages: unknown[];
  totalMessages: number;
};

const RECENT_SESSION_MESSAGES_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

type TailTranscriptRecord = {
  id?: string;
  parentId?: string | null;
  record: Record<string, unknown>;
};

export function readRecentSessionMessages(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  opts?: ReadRecentSessionMessagesOptions,
): unknown[] {
  const maxMessages = Math.max(0, Math.floor(opts?.maxMessages ?? 0));
  if (maxMessages === 0) {
    return [];
  }

  const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile);
  if (!filePath) {
    return [];
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return [];
  }
  if (stat.size === 0) {
    return [];
  }

  const maxBytes = Math.max(
    1024,
    Math.floor(opts?.maxBytes ?? RECENT_SESSION_MESSAGES_DEFAULT_MAX_BYTES),
  );
  const readLen = Math.min(stat.size, maxBytes);
  const readStart = Math.max(0, stat.size - readLen);
  const maxLines = Math.max(maxMessages, Math.floor(opts?.maxLines ?? maxMessages * 20 + 20));

  return (
    withOpenTranscriptFd(filePath, (fd) => {
      const buf = Buffer.alloc(readLen);
      const bytesRead = fs.readSync(fd, buf, 0, readLen, readStart);
      if (bytesRead <= 0) {
        return [];
      }
      const chunk = buf.toString("utf-8", 0, bytesRead);
      const lines = chunk
        .split(/\r?\n/)
        .slice(readStart > 0 ? 1 : 0)
        .filter((line) => line.trim().length > 0)
        .slice(-maxLines);

      return parseRecentTranscriptTailMessages(lines, maxMessages);
    }) ?? []
  );
}

async function readRecentTranscriptTailLinesAsync(
  filePath: string,
  stat: fs.Stats,
  opts: ReadRecentSessionMessagesOptions,
): Promise<string[]> {
  const maxMessages = Math.max(0, Math.floor(opts.maxMessages));
  const maxBytes = Math.max(
    1024,
    Math.floor(opts.maxBytes ?? RECENT_SESSION_MESSAGES_DEFAULT_MAX_BYTES),
  );
  const readLen = Math.min(stat.size, maxBytes);
  const readStart = Math.max(0, stat.size - readLen);
  const maxLines = Math.max(maxMessages, Math.floor(opts.maxLines ?? maxMessages * 20 + 20));
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(readLen);
    const { bytesRead } = await handle.read(buffer, 0, readLen, readStart);
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
const TRANSCRIPT_OVERSIZED_MESSAGE_PLACEHOLDER = "[chat.history omitted: message too large]";

function isOversizedTranscriptLine(line: string): boolean {
  return Buffer.byteLength(line, "utf8") > MAX_TRANSCRIPT_PARSE_LINE_BYTES;
}

function extractJsonStringFieldPrefix(prefix: string, field: string): string | undefined {
  const match = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(prefix);
  if (!match) {
    return undefined;
  }
  try {
    const decoded = JSON.parse(`"${match[1]}"`) as unknown;
    return normalizeTailEntryString(decoded);
  } catch {
    return undefined;
  }
}

function extractJsonNullableStringFieldPrefix(
  prefix: string,
  field: string,
): string | null | undefined {
  if (new RegExp(`"${field}"\\s*:\\s*null`).test(prefix)) {
    return null;
  }
  return extractJsonStringFieldPrefix(prefix, field);
}

function buildOversizedTranscriptRecord(line: string): TailTranscriptRecord {
  const prefix = line.slice(0, OVERSIZED_TRANSCRIPT_METADATA_PREFIX_CHARS);
  const id = extractJsonStringFieldPrefix(prefix, "id");
  const parentId = extractJsonNullableStringFieldPrefix(prefix, "parentId");
  const type = extractJsonStringFieldPrefix(prefix, "type");
  const role = extractJsonStringFieldPrefix(prefix, "role") ?? "assistant";
  const record: Record<string, unknown> = {
    ...(type ? { type } : {}),
    ...(id ? { id } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
    message: {
      role,
      content: [{ type: "text", text: TRANSCRIPT_OVERSIZED_MESSAGE_PLACEHOLDER }],
      __openclaw: { truncated: true, reason: "oversized" },
    },
  };
  return {
    ...(id ? { id } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
    record,
  };
}

function normalizeTailEntryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
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
    return {
      ...(normalizeTailEntryString(record.id) ? { id: normalizeTailEntryString(record.id) } : {}),
      ...(record.parentId === null
        ? { parentId: null }
        : normalizeTailEntryString(record.parentId)
          ? { parentId: normalizeTailEntryString(record.parentId) }
          : {}),
      record,
    };
  } catch {
    return null;
  }
}

function tailRecordHasTreeLink(entry: TailTranscriptRecord): boolean {
  return (
    entry.record.type !== "session" &&
    typeof entry.id === "string" &&
    Object.hasOwn(entry.record, "parentId")
  );
}

function selectBoundedActiveTailRecords(entries: TailTranscriptRecord[]): TailTranscriptRecord[] {
  const byId = new Map<string, TailTranscriptRecord>();
  let leafId: string | undefined;
  for (const entry of entries) {
    if (entry.id) {
      byId.set(entry.id, entry);
    }
    if (tailRecordHasTreeLink(entry) && entry.id) {
      leafId = entry.id;
    }
  }
  if (!leafId) {
    return entries;
  }

  const selected: TailTranscriptRecord[] = [];
  const seen = new Set<string>();
  let currentId: string | undefined = leafId;
  while (currentId) {
    if (seen.has(currentId)) {
      return [];
    }
    seen.add(currentId);
    const entry = byId.get(currentId);
    if (!entry) {
      break;
    }
    selected.push(entry);
    currentId = entry.parentId ?? undefined;
  }
  const activeBranch = selected.toReversed();
  const firstActiveRecord = activeBranch[0];
  const firstActiveIndex = firstActiveRecord ? entries.indexOf(firstActiveRecord) : -1;
  if (firstActiveIndex > 0) {
    for (let index = firstActiveIndex - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.record.type === "compaction") {
        return [entry, ...activeBranch];
      }
    }
  }
  return activeBranch;
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
  return records.some(tailRecordHasTreeLink) ? selectBoundedActiveTailRecords(records) : records;
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

function parseRecentTranscriptTailMessages(lines: string[], maxMessages: number): unknown[] {
  const entries = lines.flatMap((line) => {
    const entry = parseTailTranscriptRecord(line);
    return entry ? [entry] : [];
  });
  return transcriptRecordsToMessages(selectActiveTranscriptRecords(entries)).slice(-maxMessages);
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

export function visitSessionMessages(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  visit: (message: unknown, seq: number) => void,
): number {
  const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile);
  if (!filePath) {
    return 0;
  }

  const messages = transcriptRecordsToMessages(readSelectedTranscriptRecords(filePath));
  for (const [index, message] of messages.entries()) {
    visit(message, index + 1);
  }
  return messages.length;
}

export function readSessionMessageCount(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
): number {
  const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile);
  if (!filePath) {
    return 0;
  }
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(filePath);
    const cached = getCachedTranscriptMessageCount(filePath, stat);
    if (typeof cached === "number") {
      return cached;
    }
  } catch {
    // Count from the transcript reader below when stat metadata is unavailable.
  }
  const count = visitSessionMessages(sessionId, storePath, sessionFile, () => undefined);
  if (stat) {
    setCachedTranscriptMessageCount(filePath, stat, count);
  }
  return count;
}

export async function readSessionMessagesAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  opts: ReadSessionMessagesAsyncOptions,
): Promise<unknown[]> {
  if (opts.mode === "recent") {
    const { mode: _mode, ...recentOpts } = opts;
    return await readRecentSessionMessagesAsync(sessionId, storePath, sessionFile, recentOpts);
  }
  const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile);
  if (!filePath) {
    return [];
  }
  const index = await readSessionTranscriptIndex(filePath);
  return index?.entries.flatMap((entry) => indexedTranscriptEntryToMessages(entry)) ?? [];
}

export async function visitSessionMessagesAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  visit: (message: unknown, seq: number) => void,
  _opts: { mode: "full"; reason: string },
): Promise<number> {
  const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile);
  if (!filePath) {
    return 0;
  }
  const index = await readSessionTranscriptIndex(filePath);
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
): Promise<number> {
  const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile);
  if (!filePath) {
    return 0;
  }
  let stat: fs.Stats | null = null;
  try {
    stat = await fs.promises.stat(filePath);
    const cached = getCachedTranscriptMessageCount(filePath, stat);
    if (typeof cached === "number") {
      return cached;
    }
  } catch {
    // Count from the transcript reader below when stat metadata is unavailable.
  }
  const index = await readSessionTranscriptIndex(filePath);
  const count = index?.entries.length ?? 0;
  if (stat) {
    setCachedTranscriptMessageCount(filePath, stat, count);
  }
  return count;
}

export function readRecentSessionMessagesWithStats(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  opts: ReadRecentSessionMessagesOptions,
): ReadRecentSessionMessagesResult {
  const totalMessages = readSessionMessageCount(sessionId, storePath, sessionFile);
  const messages = readRecentSessionMessages(sessionId, storePath, sessionFile, opts);
  const firstSeq = Math.max(1, totalMessages - messages.length + 1);
  const messagesWithSeq = messages.map((message, index) =>
    attachOpenClawTranscriptMeta(message, { seq: firstSeq + index }),
  );
  return { messages: messagesWithSeq, totalMessages };
}

export async function readRecentSessionMessagesAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  opts?: ReadRecentSessionMessagesOptions,
): Promise<unknown[]> {
  const maxMessages = Math.max(0, Math.floor(opts?.maxMessages ?? 0));
  if (maxMessages === 0) {
    return [];
  }

  const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile);
  if (!filePath) {
    return [];
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return [];
  }
  if (stat.size === 0) {
    return [];
  }
  const lines = await readRecentTranscriptTailLinesAsync(filePath, stat, {
    ...opts,
    maxMessages,
  });
  return parseRecentTranscriptTailMessages(lines, maxMessages);
}

export async function readRecentSessionMessagesWithStatsAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  opts: ReadRecentSessionMessagesOptions,
): Promise<ReadRecentSessionMessagesResult> {
  const totalMessages = await readSessionMessageCountAsync(sessionId, storePath, sessionFile);
  const messages = await readRecentSessionMessagesAsync(sessionId, storePath, sessionFile, opts);
  const firstSeq = Math.max(1, totalMessages - messages.length + 1);
  const messagesWithSeq = messages.map((message, index) =>
    attachOpenClawTranscriptMeta(message, { seq: firstSeq + index }),
  );
  return { messages: messagesWithSeq, totalMessages };
}

export function readRecentSessionTranscriptLines(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
  maxLines: number;
}): { lines: string[]; totalLines: number } | null {
  const filePath = findExistingTranscriptPath(
    params.sessionId,
    params.storePath,
    params.sessionFile,
    params.agentId,
  );
  if (!filePath) {
    return null;
  }
  const maxLines = Math.max(1, Math.floor(params.maxLines));
  const lines: string[] = [];
  let totalLines = 0;
  try {
    visitTranscriptLines(filePath, (line) => {
      if (!line.trim()) {
        return;
      }
      totalLines += 1;
      lines.push(line);
      if (lines.length > maxLines) {
        lines.shift();
      }
    });
  } catch {
    return null;
  }
  return { lines, totalLines };
}

function parsedSessionEntryToMessage(parsed: unknown, seq: number): unknown {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const entry = parsed as Record<string, unknown>;
  if (entry.message) {
    return attachOpenClawTranscriptMeta(entry.message, {
      ...(typeof entry.id === "string" ? { id: entry.id } : {}),
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

function indexedTranscriptEntryToMessages(entry: IndexedTranscriptEntry): unknown[] {
  const message = indexedTranscriptEntryToMessage(entry);
  return message ? [message] : [];
}

export {
  archiveFileOnDisk,
  archiveSessionTranscripts,
  cleanupArchivedSessionTranscripts,
  resolveSessionTranscriptCandidates,
} from "./session-transcript-files.fs.js";

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
    bytes -= parts[start] + 1;
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
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId);
  const filePath = candidates.find((p) => fs.existsSync(p));
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
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId);
  const filePath = candidates.find((p) => fs.existsSync(p));
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
  const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
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
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
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

function findExistingTranscriptPath(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): string | null {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
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

export function readFirstUserMessageFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
  opts?: { includeInterSession?: boolean },
): string | null {
  const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
  if (!filePath) {
    return null;
  }

  return withOpenTranscriptFd(filePath, (fd) => {
    const chunk = readTranscriptHeadChunk(fd);
    if (!chunk) {
      return null;
    }
    return extractFirstUserMessageFromTranscriptChunk(chunk, opts);
  });
}

const LAST_MSG_MAX_BYTES = 16384;
const LAST_MSG_MAX_LINES = 20;

function readLastMessagePreviewFromOpenTranscript(params: {
  fd: number;
  size: number;
}): string | null {
  const readStart = Math.max(0, params.size - LAST_MSG_MAX_BYTES);
  const readLen = Math.min(params.size, LAST_MSG_MAX_BYTES);
  const buf = Buffer.alloc(readLen);
  fs.readSync(params.fd, buf, 0, readLen, readStart);

  const chunk = buf.toString("utf-8");
  const lines = chunk.split(/\r?\n/).filter((l) => l.trim());
  const tailLines = lines.slice(-LAST_MSG_MAX_LINES);

  for (let i = tailLines.length - 1; i >= 0; i--) {
    const line = tailLines[i];
    try {
      const parsed = JSON.parse(line);
      const msg = parsed?.message as TranscriptMessage | undefined;
      if (msg?.role !== "user" && msg?.role !== "assistant") {
        continue;
      }
      const text = extractTextFromContent(msg.content);
      if (text) {
        return text;
      }
    } catch {
      // skip malformed
    }
  }
  return null;
}

async function readLastMessagePreviewFromOpenTranscriptAsync(params: {
  handle: TranscriptFileHandle;
  size: number;
}): Promise<string | null> {
  const readStart = Math.max(0, params.size - LAST_MSG_MAX_BYTES);
  const readLen = Math.min(params.size, LAST_MSG_MAX_BYTES);
  const buffer = Buffer.alloc(readLen);
  const { bytesRead } = await params.handle.read(buffer, 0, readLen, readStart);
  if (bytesRead <= 0) {
    return null;
  }

  const chunk = buffer.toString("utf-8", 0, bytesRead);
  const lines = chunk.split(/\r?\n/).filter((line) => line.trim());
  const tailLines = lines.slice(-LAST_MSG_MAX_LINES);

  for (let i = tailLines.length - 1; i >= 0; i--) {
    const line = tailLines[i];
    try {
      const parsed = JSON.parse(line);
      const msg = parsed?.message as TranscriptMessage | undefined;
      if (msg?.role !== "user" && msg?.role !== "assistant") {
        continue;
      }
      const text = extractTextFromContent(msg.content);
      if (text) {
        return text;
      }
    } catch {
      // skip malformed
    }
  }
  return null;
}

export function readLastMessagePreviewFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): string | null {
  const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
  if (!filePath) {
    return null;
  }

  return withOpenTranscriptFd(filePath, (fd) => {
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    if (size === 0) {
      return null;
    }
    return readLastMessagePreviewFromOpenTranscript({ fd, size });
  });
}

type SessionTranscriptUsageSnapshot = {
  modelProvider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
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

  for (const line of lines) {
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
    if (typeof current.totalTokens === "number") {
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
  return snapshot;
}

function extractLatestUsageFromTranscriptLines(
  lines: Iterable<string>,
): SessionTranscriptUsageSnapshot | null {
  let latest: SessionTranscriptUsageSnapshot | null = null;
  for (const line of lines) {
    latest = extractUsageSnapshotFromTranscriptLine(line) ?? latest;
  }
  return latest;
}

function extractAggregateUsageFromTranscriptChunk(
  chunk: string,
): SessionTranscriptUsageSnapshot | null {
  return extractAggregateUsageFromTranscriptLines(
    chunk.split(/\r?\n/).filter((line) => line.trim().length > 0),
  );
}

export function readLatestSessionUsageFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
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
    const chunk = fs.readFileSync(fd, "utf-8");
    return extractAggregateUsageFromTranscriptChunk(chunk);
  });
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

export async function readRecentSessionUsageFromTranscriptAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  agentId: string | undefined,
  maxBytes: number,
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
    const lines = await readRecentTranscriptTailLinesAsync(filePath, stat, {
      maxMessages: 1,
      maxLines: 1000,
      maxBytes,
    });
    return extractAggregateUsageFromTranscriptLines(lines);
  } catch {
    return null;
  }
}

export async function readLatestRecentSessionUsageFromTranscriptAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  agentId: string | undefined,
  maxBytes: number,
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
    const lines = await readRecentTranscriptTailLinesAsync(filePath, stat, {
      maxMessages: 1,
      maxLines: 1000,
      maxBytes,
    });
    return extractLatestUsageFromTranscriptLines(lines);
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
    const bytesRead = fs.readSync(fd, buf, 0, readLen, readStart);
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
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 3) {
    return text.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - 3)}...`;
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

function buildPreviewItems(
  messages: TranscriptPreviewMessage[],
  maxItems: number,
  maxChars: number,
): SessionPreviewItem[] {
  const items: SessionPreviewItem[] = [];
  for (const message of messages) {
    const toolCall = isToolCall(message);
    const role = normalizeRole(message.role, toolCall);
    let text = extractPreviewText(message);
    if (!text) {
      const toolNames = extractToolNames(message);
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
      text = extractMediaSummary(message);
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
    fs.readSync(fd, buf, 0, readLen, readStart);

    const chunk = buf.toString("utf-8");
    const lines = chunk.split(/\r?\n/).filter((l) => l.trim());
    const tailLines = lines.slice(-PREVIEW_MAX_LINES);

    const collected: TranscriptPreviewMessage[] = [];
    for (let i = tailLines.length - 1; i >= 0; i--) {
      const line = tailLines[i];
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
      return buildPreviewItems(messages, boundedItems, boundedChars);
    }
  }

  return [];
}
