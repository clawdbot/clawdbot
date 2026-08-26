// Filesystem session history readers.
// Parses transcript JSONL files for messages, previews, counts, and usage metadata.
import fs from "node:fs";
import readline from "node:readline";
import { expectDefined } from "@openclaw/normalization-core";
import {
  resolveIntegerOption,
  resolveNonNegativeIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import { materializeSessionArchiveForRead } from "../config/sessions/archive-compression.js";
import type { TranscriptEvent } from "../config/sessions/session-accessor.js";
import { streamSessionTranscriptLines } from "../config/sessions/transcript-stream.js";
import { selectSessionTranscriptActiveEntries } from "../config/sessions/transcript-tree.js";
import { readFileWindowFully } from "../infra/file-read.js";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { projectSessionDisplayMessage } from "./session-display-projection.js";
import {
  aggregateSessionTranscriptUsage,
  type SessionTranscriptUsageSnapshot,
} from "./session-transcript-derived-readers.js";
import {
  resolveSessionTranscriptCandidates,
  resolveSessionTranscriptResetArchiveCandidatesAsync,
} from "./session-transcript-files.fs.js";
import {
  extractJsonNullableStringFieldPrefix,
  extractJsonNumberFieldPrefix,
  extractJsonStringFieldPrefix,
  readNonBlankStringPreservingWhitespace,
} from "./session-transcript-json.js";
import {
  attachOpenClawTranscriptMeta,
  projectTranscriptEntryMessage,
} from "./session-transcript-message.js";
import type { SessionPreviewItem } from "./session-utils.types.js";

export type { SessionTranscriptUsageSnapshot } from "./session-transcript-derived-readers.js";

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

type ReadRecentSessionMessagesResult = {
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

type TranscriptRecord = {
  byteLength: number;
  id?: string;
  /** Private provenance; synthesized oversized placeholders must never qualify. */
  recoveredImageData?: true;
  record: Record<string, unknown>;
};

type IndexedTranscriptEntry = TranscriptRecord & { seq: number };

type SessionTranscriptIndex = {
  entries: IndexedTranscriptEntry[];
};

type CachedTranscriptIndex = {
  identity: string;
  value: Promise<SessionTranscriptIndex>;
};

type ResolvedTranscriptArtifact = {
  path: string;
  source: "active" | "reset-archive";
};

type ArchivedTranscriptReadScope = {
  agentId?: string | undefined;
  sessionFile?: string | undefined;
  sessionId: string;
  storePath?: string | undefined;
};

const transcriptIndexes = new Map<string, CachedTranscriptIndex>();
const MAX_TRANSCRIPT_INDEXES = 256;

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
const MAX_OVERSIZED_TRANSCRIPT_RECOVERY_CANDIDATES = 32;
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

function recoverOversizedMultimodalTranscriptRecord(
  line: string,
): Record<string, unknown> | undefined {
  const markerPrefix = "__openclaw_omitted_image_";
  if (line.includes(markerPrefix)) {
    return undefined;
  }
  const payloads: Array<{ start: number; end: number; marker: string; bytes: number }> = [];
  const dataPattern = /"data"\s*:\s*"/g;
  let scannedCandidates = 0;
  for (let dataMatch = dataPattern.exec(line); dataMatch; dataMatch = dataPattern.exec(line)) {
    if (!isJsonObjectFieldToken(line, dataMatch.index)) {
      continue;
    }
    if (++scannedCandidates > MAX_OVERSIZED_TRANSCRIPT_RECOVERY_CANDIDATES) {
      return undefined;
    }
    const start = dataMatch.index + dataMatch[0].length;
    let end = start;
    let padding = 0;
    let valid = true;
    for (; end < line.length && line.charCodeAt(end) !== 34; end++) {
      const code = line.charCodeAt(end);
      if (code === 92) {
        valid = false;
        end++;
        continue;
      }
      if (!valid) {
        continue;
      }
      if (code === 61) {
        if (++padding > 2) {
          valid = false;
        }
      } else if (
        padding > 0 ||
        (((code | 32) < 97 || (code | 32) > 122) &&
          (code < 48 || code > 57) &&
          code !== 43 &&
          code !== 47)
      ) {
        valid = false;
      }
    }
    if (end >= line.length) {
      return undefined;
    }
    dataPattern.lastIndex = end + 1;
    if (!valid || (end - start) % 4 !== 0) {
      continue;
    }
    payloads.push({
      start,
      end,
      marker: `${markerPrefix}${payloads.length}__`,
      bytes: ((end - start) * 3) / 4 - padding,
    });
  }
  if (payloads.length === 0) {
    return undefined;
  }
  try {
    const parseBoundedRedaction = (
      selected: typeof payloads,
    ): Record<string, unknown> | undefined => {
      const bytes = selected.reduce(
        (remaining, payload) => remaining - (payload.end - payload.start - payload.marker.length),
        Buffer.byteLength(line, "utf8"),
      );
      if (selected.length === 0 || bytes > MAX_TRANSCRIPT_PARSE_LINE_BYTES) {
        return undefined;
      }
      let cursor = 0;
      const parts: string[] = [];
      for (const payload of selected) {
        parts.push(line.slice(cursor, payload.start), payload.marker);
        cursor = payload.end;
      }
      parts.push(line.slice(cursor));
      const markers = new Set(selected.map((payload) => payload.marker));
      const parsed = JSON.parse(parts.join(""), (_key: string, value: unknown) => {
        if (typeof value === "string" && value.startsWith(markerPrefix) && !markers.delete(value)) {
          throw new Error("invalid transcript image recovery marker");
        }
        return value;
      }) as unknown;
      if (markers.size > 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return undefined;
      }
      return parsed as Record<string, unknown>;
    };
    const imageDataOwners = (block: Record<string, unknown>): Record<string, unknown>[] => {
      const source = block.source as Record<string, unknown> | undefined;
      return source && typeof source === "object" && source.type === "base64"
        ? [block, source]
        : [block];
    };

    // Parse all bounded candidates once, then classify image ownership from real JSON structure.
    const preview = parseBoundedRedaction(payloads);
    const previewContent = (preview?.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(previewContent)) {
      return undefined;
    }
    const payloadByMarker = new Map(payloads.map((payload) => [payload.marker, payload]));
    const imageMarkers = new Set<string>();
    for (const candidate of previewContent) {
      if (!candidate || typeof candidate !== "object" || candidate.type !== "image") {
        continue;
      }
      for (const owner of imageDataOwners(candidate as Record<string, unknown>)) {
        if (typeof owner.data !== "string") {
          continue;
        }
        if (!payloadByMarker.has(owner.data) || imageMarkers.has(owner.data)) {
          return undefined;
        }
        imageMarkers.add(owner.data);
      }
    }
    if (imageMarkers.size === 0) {
      return undefined;
    }

    // Rebuild from the original line so document and metadata bytes remain untouched.
    const imagePayloads = payloads.filter((payload) => imageMarkers.has(payload.marker));
    const record = parseBoundedRedaction(imagePayloads);
    const content = (record?.message as { content?: unknown } | undefined)?.content;
    if (!record || !Array.isArray(content)) {
      return undefined;
    }
    const remaining = new Map(imagePayloads.map((payload) => [payload.marker, payload]));
    for (const candidate of content) {
      if (!candidate || typeof candidate !== "object" || candidate.type !== "image") {
        continue;
      }
      const block = candidate as Record<string, unknown>;
      let imageBytes: number | undefined;
      for (const owner of imageDataOwners(block)) {
        if (typeof owner.data !== "string") {
          continue;
        }
        const payload = remaining.get(owner.data);
        if (!payload) {
          return undefined;
        }
        remaining.delete(payload.marker);
        imageBytes ??= payload.bytes;
        delete owner.data;
      }
      if (imageBytes !== undefined) {
        block.omitted = true;
        block.bytes = imageBytes;
      }
    }
    // Parsed numeric spellings can expand, so both archive readers need the final UTF-8 bound.
    return remaining.size === 0 && jsonUtf8Bytes(record) <= MAX_TRANSCRIPT_PARSE_LINE_BYTES
      ? record
      : undefined;
  } catch {
    return undefined;
  }
}

function parseTranscriptRecord(line: string): TranscriptRecord | null {
  const oversized = isOversizedTranscriptLine(line);
  const recoveredRecord = oversized ? recoverOversizedMultimodalTranscriptRecord(line) : undefined;
  if (!oversized || recoveredRecord) {
    try {
      const parsed = recoveredRecord ?? (JSON.parse(line) as unknown);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      const record = parsed as Record<string, unknown>;
      const id = readNonBlankStringPreservingWhitespace(record.id);
      return {
        byteLength: Buffer.byteLength(line, "utf8"),
        ...(id ? { id } : {}),
        ...(recoveredRecord ? { recoveredImageData: true as const } : {}),
        record,
      };
    } catch {
      return null;
    }
  }
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
  return {
    byteLength: Buffer.byteLength(line, "utf8"),
    ...(id ? { id } : {}),
    record,
  };
}

function parseRecentTranscriptTailSnapshot(
  lines: string[],
  maxMessages: number,
): { messages: unknown[]; transcriptEvents: TranscriptEvent[] } {
  const entries = lines.flatMap((line) => {
    const entry = parseTranscriptRecord(line);
    return entry ? [entry] : [];
  });
  const selected = projectResetBoundary(
    selectSessionTranscriptActiveEntries({
      entries,
      recordOf: (entry) => entry.record,
      failClosedOnInvalidLeafControl: true,
    }),
  );
  const messages: unknown[] = [];
  for (const entry of selected) {
    const message = projectTranscriptEntryMessage(entry.record, messages.length + 1);
    if (message) {
      messages.push(message);
    }
  }
  return {
    messages: messages.slice(-maxMessages),
    transcriptEvents: selected.map((entry) => entry.record),
  };
}

function isVisibleTranscriptRecord(record: Record<string, unknown>): boolean {
  return Boolean(record.message) || record.type === "compaction" || record.type === "reset";
}

function projectResetBoundary(entries: TranscriptRecord[]): TranscriptRecord[] {
  const boundaryIndex = entries.findLastIndex(({ record }) => {
    return record.type === "compaction" || record.type === "reset";
  });
  if (boundaryIndex < 0 || entries[boundaryIndex]?.record.type !== "reset") {
    return entries;
  }
  const firstKeptEntryId = entries[boundaryIndex]?.record.firstKeptEntryId;
  const firstKeptIndex =
    typeof firstKeptEntryId === "string"
      ? entries.findIndex((entry, index) => index < boundaryIndex && entry.id === firstKeptEntryId)
      : -1;
  const kept =
    firstKeptIndex < 0
      ? []
      : entries.slice(firstKeptIndex, boundaryIndex).filter(({ record }) => {
          const role = (record.message as { role?: unknown } | undefined)?.role;
          return role === "user" || role === "assistant";
        });
  return [...kept, ...entries.slice(boundaryIndex)];
}

function toIndexedEntries(entries: TranscriptRecord[]): IndexedTranscriptEntry[] {
  const indexed: IndexedTranscriptEntry[] = [];
  for (const entry of entries) {
    if (isVisibleTranscriptRecord(entry.record)) {
      indexed.push({ ...entry, seq: indexed.length + 1 });
    }
  }
  return indexed;
}

async function buildSessionTranscriptIndex(filePath: string): Promise<SessionTranscriptIndex> {
  const records: TranscriptRecord[] = [];
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim()) {
        const record = parseTranscriptRecord(line);
        if (record) {
          records.push(record);
        }
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  const active = selectSessionTranscriptActiveEntries({
    entries: records,
    recordOf: (entry) => entry.record,
  });
  return {
    entries: toIndexedEntries(projectResetBoundary(active)),
  };
}

async function readSessionTranscriptIndex(
  filePath: string,
  opts: { cache?: "reuse" | "skip" } = {},
): Promise<SessionTranscriptIndex | null> {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    transcriptIndexes.delete(filePath);
    return null;
  }
  const identity = `${stat.mtimeMs}:${stat.size}`;
  let cached = opts.cache === "skip" ? undefined : transcriptIndexes.get(filePath);
  if (cached?.identity === identity) {
    transcriptIndexes.delete(filePath);
    transcriptIndexes.set(filePath, cached);
  }
  if (cached?.identity !== identity) {
    cached = { identity, value: buildSessionTranscriptIndex(filePath) };
    if (opts.cache !== "skip") {
      transcriptIndexes.delete(filePath);
      transcriptIndexes.set(filePath, cached);
      pruneMapToMaxSize(transcriptIndexes, MAX_TRANSCRIPT_INDEXES);
    }
  }
  let index: SessionTranscriptIndex;
  try {
    index = await cached.value;
  } catch (error) {
    if (transcriptIndexes.get(filePath) === cached) {
      transcriptIndexes.delete(filePath);
    }
    throw error;
  }
  return index;
}

function findExistingTranscriptPath(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): string | null {
  return (
    resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId).find((value) =>
      fs.existsSync(value),
    ) ?? null
  );
}

/** Single owner for bounded reads of live JSONL artifacts and cold reset archives. */
export class ArchivedTranscriptReader {
  constructor(private readonly scope: ArchivedTranscriptReadScope) {}

  async resolvePath(opts: {
    allowResetArchiveFallback?: boolean | undefined;
    resetArchiveOnly?: boolean | undefined;
  }): Promise<string | null> {
    return (await this.resolveArtifact(opts))?.path ?? null;
  }

  private activePath(): string | null {
    return findExistingTranscriptPath(
      this.scope.sessionId,
      this.scope.storePath,
      this.scope.sessionFile,
      this.scope.agentId,
    );
  }

  private async resolveArtifact(opts: {
    allowResetArchiveFallback?: boolean | undefined;
    resetArchiveOnly?: boolean | undefined;
  }): Promise<ResolvedTranscriptArtifact | null> {
    if (opts.resetArchiveOnly !== true) {
      const activePath = this.activePath();
      if (activePath) {
        return { path: activePath, source: "active" };
      }
    }
    if (opts.allowResetArchiveFallback !== true) {
      return null;
    }
    const archives = await resolveSessionTranscriptResetArchiveCandidatesAsync(
      this.scope.sessionId,
      this.scope.storePath,
      this.scope.sessionFile,
      this.scope.agentId,
    );
    for (const archivePath of archives) {
      if (!(await fs.promises.stat(archivePath).catch(() => null))?.isFile()) {
        continue;
      }
      // A live file created during discovery wins unless SQLite already selected
      // this explicitly archive-only reader after observing no live rows.
      if (opts.resetArchiveOnly !== true) {
        const activePath = this.activePath();
        if (activePath) {
          return { path: activePath, source: "active" };
        }
      }
      try {
        return {
          path: materializeSessionArchiveForRead(archivePath),
          source: "reset-archive",
        };
      } catch {
        continue;
      }
    }
    return null;
  }

  async read(opts: ReadSessionMessagesAsyncOptions): Promise<ReadSessionMessagesResult> {
    const artifact = await this.resolveArtifact(opts);
    if (!artifact) {
      return { messages: [] };
    }
    if (opts.mode === "recent") {
      if (normalizeRecentSessionReadOptions(opts).maxMessages === 0) {
        return { messages: [] };
      }
      const snapshot = await readRecentSessionSnapshotFromPathAsync(
        artifact.path,
        normalizeRecentSessionReadOptions(opts),
      );
      return { messages: snapshot.messages, transcriptPath: artifact.path };
    }
    const index = await readSessionTranscriptIndex(artifact.path);
    return {
      messages: index?.entries.flatMap(indexedTranscriptEntryToMessages) ?? [],
      transcriptPath: artifact.path,
    };
  }

  async readById(
    messageId: string,
    opts: { allowResetArchiveFallback?: boolean; resetArchiveOnly?: boolean },
  ): Promise<{ message?: unknown; seq?: number; oversized: boolean; found: boolean }> {
    const artifact = await this.resolveArtifact(opts);
    if (!artifact) {
      return { oversized: false, found: false };
    }
    const entry = (await readSessionTranscriptIndex(artifact.path))?.entries.find(
      (candidate) => candidate.id === messageId,
    );
    if (!entry) {
      return { oversized: false, found: false };
    }
    // Raw-byte limits still reject placeholders; only bounded, validated image recoveries qualify.
    if (
      entry.byteLength > MAX_TRANSCRIPT_PARSE_LINE_BYTES &&
      (entry.recoveredImageData !== true ||
        jsonUtf8Bytes(entry.record) > MAX_TRANSCRIPT_PARSE_LINE_BYTES)
    ) {
      return { oversized: true, found: true, seq: entry.seq };
    }
    return {
      message: indexedTranscriptEntryToMessage(entry),
      seq: entry.seq,
      oversized: false,
      found: true,
    };
  }

  async readRecentWithStats(
    opts: ReadRecentSessionMessagesOptions,
  ): Promise<ReadRecentSessionMessagesResult> {
    const artifact = await this.resolveArtifact(opts);
    if (!artifact) {
      return { messages: [], totalMessages: 0 };
    }
    const transcriptIndex = await readSessionTranscriptIndex(artifact.path);
    const totalMessages = transcriptIndex?.entries.length ?? 0;
    const normalized = normalizeRecentSessionReadOptions(opts);
    const snapshot =
      normalized.maxMessages === 0
        ? { messages: [], transcriptEvents: [] }
        : await readRecentSessionSnapshotFromPathAsync(artifact.path, normalized);
    const firstSeq = Math.max(1, totalMessages - snapshot.messages.length + 1);
    return {
      messages: snapshot.messages.map((message, index) =>
        attachOpenClawTranscriptMeta(message, { seq: firstSeq + index }),
      ),
      transcriptEvents: snapshot.transcriptEvents,
      totalMessages,
      transcriptPath: artifact.path,
      transcriptSource: artifact.source,
    };
  }

  async readPage(opts: ReadSessionMessagesPageOptions): Promise<ReadRecentSessionMessagesResult> {
    const artifact = await this.resolveArtifact(opts);
    if (!artifact) {
      return { messages: [], totalMessages: 0 };
    }
    const index = await readSessionTranscriptIndex(artifact.path);
    if (!index) {
      return { messages: [], totalMessages: 0, transcriptPath: artifact.path };
    }
    const totalMessages = index.entries.length;
    const offset = Math.min(resolveNonNegativeIntegerOption(opts.offset, 0), totalMessages);
    const endExclusive = Math.max(0, totalMessages - offset);
    const start = Math.max(0, endExclusive - resolveNonNegativeIntegerOption(opts.maxMessages, 0));
    const entries = index.entries.slice(start, endExclusive);
    return {
      messages: entries.flatMap(indexedTranscriptEntryToMessages),
      transcriptEvents: entries.map((entry) => entry.record),
      totalMessages,
      transcriptPath: artifact.path,
      transcriptSource: artifact.source,
    };
  }

  async readAroundId(opts: {
    messageId: string;
    maxMessages: number;
    allowResetArchiveFallback?: boolean;
    resetArchiveOnly?: boolean;
  }): Promise<
    ReadRecentSessionMessagesResult & {
      found: boolean;
      hasOverreadContext: boolean;
      offset: number;
    }
  > {
    const artifacts: ResolvedTranscriptArtifact[] = [];
    if (opts.resetArchiveOnly !== true) {
      const activePath = this.activePath();
      if (activePath) {
        artifacts.push({ path: activePath, source: "active" });
      }
    }
    if (opts.allowResetArchiveFallback === true) {
      for (const archivePath of await resolveSessionTranscriptResetArchiveCandidatesAsync(
        this.scope.sessionId,
        this.scope.storePath,
        this.scope.sessionFile,
        this.scope.agentId,
      )) {
        try {
          artifacts.push({
            path: materializeSessionArchiveForRead(archivePath),
            source: "reset-archive",
          });
        } catch {
          // Try the next valid retained generation.
        }
      }
    }
    let activeTotalMessages = 0;
    for (const artifact of artifacts) {
      const index = await readSessionTranscriptIndex(artifact.path);
      if (!index) {
        continue;
      }
      if (artifact.source === "active") {
        activeTotalMessages = index.entries.length;
      }
      const anchorIndex = index.entries.findIndex((entry) => entry.id === opts.messageId);
      if (anchorIndex < 0) {
        continue;
      }
      const pageSize = Math.max(1, Math.floor(opts.maxMessages));
      const olderMessages = pageSize - Math.floor(pageSize / 2) - 1;
      const start = Math.min(
        Math.max(0, anchorIndex - olderMessages),
        Math.max(0, index.entries.length - pageSize),
      );
      const endExclusive = Math.min(index.entries.length, start + pageSize);
      const readStart = Math.max(0, start - 1);
      return {
        found: true,
        hasOverreadContext: readStart < start,
        messages: index.entries
          .slice(readStart, endExclusive)
          .flatMap(indexedTranscriptEntryToMessages),
        offset: index.entries.length - endExclusive,
        totalMessages: index.entries.length,
        transcriptPath: artifact.path,
        transcriptSource: artifact.source,
      };
    }
    return {
      found: false,
      hasOverreadContext: false,
      messages: [],
      offset: 0,
      totalMessages: activeTotalMessages,
    };
  }
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

function indexedTranscriptEntryToMessage(entry: IndexedTranscriptEntry): unknown {
  return projectTranscriptEntryMessage(entry.record, entry.seq);
}

function indexedTranscriptEntryToMessages(entry: IndexedTranscriptEntry): unknown[] {
  const message = indexedTranscriptEntryToMessage(entry);
  return message ? [message] : [];
}

export { resolveSessionTranscriptCandidates } from "./session-transcript-files.fs.js";

export function capArrayByJsonBytes<T>(
  items: T[],
  maxBytes: number,
  byteLength: (item: T) => number = jsonUtf8Bytes,
): { items: T[]; bytes: number } {
  if (items.length === 0) {
    return { items, bytes: 2 };
  }
  const parts = items.map(byteLength);
  let bytes = 2 + parts.reduce((a, b) => a + b, 0) + (items.length - 1);
  let start = 0;
  while (bytes > maxBytes && start < items.length - 1) {
    bytes -= expectDefined(parts[start], "parts entry at start") + 1;
    start += 1;
  }
  const next = start > 0 ? items.slice(start) : items;
  return { items: next, bytes };
}

export async function resolveSessionHistoryTranscriptPathAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  opts?: { agentId?: string; allowResetArchiveFallback?: boolean },
): Promise<string | null> {
  return await new ArchivedTranscriptReader({
    agentId: opts?.agentId,
    sessionFile,
    sessionId,
    storePath,
  }).resolvePath({
    allowResetArchiveFallback: opts?.allowResetArchiveFallback,
  });
}

export async function readLatestSessionUsageFromTranscriptFileAsync(
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
    const messages: unknown[] = [];
    for await (const line of streamSessionTranscriptLines(filePath)) {
      if (isOversizedTranscriptLine(line)) {
        continue;
      }
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (
          !record.message ||
          typeof record.message !== "object" ||
          Array.isArray(record.message)
        ) {
          continue;
        }
        const message = record.message as Record<string, unknown>;
        const usage =
          message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
            ? message.usage
            : record.usage;
        messages.push({
          ...message,
          ...(typeof message.provider !== "string" && typeof record.provider === "string"
            ? { provider: record.provider }
            : {}),
          ...(typeof message.model !== "string" && typeof record.model === "string"
            ? { model: record.model }
            : {}),
          ...(usage && typeof usage === "object" && !Array.isArray(usage) ? { usage } : {}),
        });
      } catch {
        continue;
      }
    }
    return aggregateSessionTranscriptUsage(messages, "artifact");
  } catch {
    return null;
  }
}

export function buildSessionPreviewItems(
  messages: readonly unknown[],
  maxItems: number,
  maxChars: number,
): SessionPreviewItem[] {
  const items: SessionPreviewItem[] = [];
  for (const message of messages) {
    const projected = projectSessionDisplayMessage(message, { maxChars });
    if (!projected) {
      continue;
    }
    items.push(projected);
  }

  if (items.length <= maxItems) {
    return items;
  }
  return items.slice(-maxItems);
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
