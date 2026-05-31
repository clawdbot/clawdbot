import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

const TRANSCRIPT_INDEX_READ_CHUNK_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_INDEX_CACHE_ENTRIES = 256;
const MAX_TRANSCRIPT_INDEX_PARSE_LINE_BYTES = 256 * 1024;
const OVERSIZED_TRANSCRIPT_METADATA_PREFIX_CHARS = 64 * 1024;
const TRANSCRIPT_OVERSIZED_MESSAGE_PLACEHOLDER = "[chat.history omitted: message too large]";

type ParsedTranscriptRecord = Record<string, unknown>;

export type IndexedTranscriptEntry = {
  seq: number;
  id?: string;
  offset: number;
  byteLength: number;
  record: ParsedTranscriptRecord;
};

type SessionTranscriptIndex = {
  filePath: string;
  mtimeMs: number;
  size: number;
  hasTreeEntries: boolean;
  leafId?: string;
  entries: IndexedTranscriptEntry[];
};

type IndexedRawEntry = {
  id?: string;
  parentId?: string | null;
  offset: number;
  byteLength: number;
  record: ParsedTranscriptRecord;
};

type CacheEntry = {
  mtimeMs: number;
  size: number;
  index: SessionTranscriptIndex;
};

type ReadSessionTranscriptIndexOptions = {
  cache?: "reuse" | "skip";
};

const transcriptIndexCache = new Map<string, CacheEntry>();
const transcriptIndexBuilds = new Map<
  string,
  {
    mtimeMs: number;
    size: number;
    promise: Promise<SessionTranscriptIndex>;
  }
>();

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractJsonStringFieldPrefix(prefix: string, field: string): string | undefined {
  const match = new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(prefix);
  if (!match) {
    return undefined;
  }
  try {
    const decoded = JSON.parse(`"${match[1]}"`) as unknown;
    return normalizeOptionalString(decoded);
  } catch {
    return undefined;
  }
}

function extractJsonNullableStringFieldPrefix(
  prefix: string,
  field: string,
): string | null | undefined {
  if (new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*null`).test(prefix)) {
    return null;
  }
  return extractJsonStringFieldPrefix(prefix, field);
}

function extractJsonNumberFieldPrefix(prefix: string, field: string): number | undefined {
  const match = new RegExp(
    `"${escapeRegExp(field)}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`,
  ).exec(prefix);
  if (!match) {
    return undefined;
  }
  const decoded = Number(match[1]);
  return Number.isFinite(decoded) ? decoded : undefined;
}

async function yieldTranscriptIndexScan(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function touchCachedIndex(filePath: string, entry: CacheEntry): SessionTranscriptIndex {
  transcriptIndexCache.delete(filePath);
  transcriptIndexCache.set(filePath, entry);
  return entry.index;
}

function setCachedIndex(filePath: string, entry: CacheEntry): void {
  transcriptIndexCache.set(filePath, entry);
  while (transcriptIndexCache.size > MAX_TRANSCRIPT_INDEX_CACHE_ENTRIES) {
    const oldestKey = transcriptIndexCache.keys().next().value;
    if (typeof oldestKey !== "string" || !oldestKey) {
      break;
    }
    transcriptIndexCache.delete(oldestKey);
  }
}

export function clearSessionTranscriptIndexCache(): void {
  transcriptIndexCache.clear();
  transcriptIndexBuilds.clear();
}

function isIndexableTranscriptRecord(record: unknown): record is ParsedTranscriptRecord {
  return Boolean(record && typeof record === "object" && !Array.isArray(record));
}

function isVisibleTranscriptRecord(record: ParsedTranscriptRecord): boolean {
  return Boolean(record.message) || record.type === "compaction";
}

function isTreeTranscriptRecord(record: ParsedTranscriptRecord): boolean {
  return record.type !== "session" && typeof record.id === "string" && "parentId" in record;
}

function buildOversizedIndexedRawEntry(params: {
  line: string;
  offset: number;
  byteLength: number;
}): IndexedRawEntry | null {
  const prefix = params.line.slice(0, OVERSIZED_TRANSCRIPT_METADATA_PREFIX_CHARS);
  const messageMatch = /"message"\s*:/.exec(prefix);
  const recordPrefix = messageMatch ? prefix.slice(0, messageMatch.index) : prefix;
  const id = extractJsonStringFieldPrefix(prefix, "id");
  const parentId = extractJsonNullableStringFieldPrefix(prefix, "parentId");
  const type = extractJsonStringFieldPrefix(prefix, "type");
  const timestamp =
    extractJsonStringFieldPrefix(recordPrefix, "timestamp") ??
    extractJsonNumberFieldPrefix(recordPrefix, "timestamp");
  const role = extractJsonStringFieldPrefix(prefix, "role") ?? "assistant";
  const record: ParsedTranscriptRecord = {
    ...(type ? { type } : {}),
    ...(id ? { id } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    message: {
      role,
      content: [{ type: "text", text: TRANSCRIPT_OVERSIZED_MESSAGE_PLACEHOLDER }],
      __openclaw: { truncated: true, reason: "oversized" },
    },
  };
  return {
    ...(id ? { id } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
    offset: params.offset,
    byteLength: params.byteLength,
    record,
  };
}

async function visitTranscriptJsonLines(
  filePath: string,
  visit: (line: string, offset: number, byteLength: number) => void,
): Promise<void> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(TRANSCRIPT_INDEX_READ_CHUNK_BYTES);
    let carry = "";
    let carryOffset = 0;
    let nextOffset = 0;

    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead <= 0) {
        break;
      }
      const chunk = buffer.subarray(0, bytesRead);
      const text = carry + decoder.write(chunk);
      const lines = text.split("\n");
      carry = lines.pop() ?? "";
      let lineOffset = carryOffset;
      for (const rawLine of lines) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        const byteLength = Buffer.byteLength(line, "utf8");
        visit(line, lineOffset, byteLength);
        lineOffset += Buffer.byteLength(rawLine, "utf8") + 1;
      }
      nextOffset += bytesRead;
      carryOffset = nextOffset - Buffer.byteLength(carry, "utf8");
      await yieldTranscriptIndexScan();
    }

    const tail = carry + decoder.end();
    if (tail) {
      const line = tail.endsWith("\r") ? tail.slice(0, -1) : tail;
      visit(line, carryOffset, Buffer.byteLength(line, "utf8"));
    }
  } finally {
    await handle.close();
  }
}

function buildActiveTreeEntries(params: {
  byId: Map<string, IndexedRawEntry>;
  leafId?: string;
}): IndexedRawEntry[] {
  const out: IndexedRawEntry[] = [];
  const seen = new Set<string>();
  let currentId = params.leafId;
  while (currentId) {
    if (seen.has(currentId)) {
      return [];
    }
    seen.add(currentId);
    const entry = params.byId.get(currentId);
    if (!entry) {
      break;
    }
    out.push(entry);
    currentId = entry.parentId ?? undefined;
  }
  return out.toReversed();
}

function toIndexedEntries(rawEntries: IndexedRawEntry[]): IndexedTranscriptEntry[] {
  const entries: IndexedTranscriptEntry[] = [];
  let seq = 0;
  for (const entry of rawEntries) {
    if (!isVisibleTranscriptRecord(entry.record)) {
      continue;
    }
    seq += 1;
    entries.push({
      seq,
      ...(entry.id ? { id: entry.id } : {}),
      offset: entry.offset,
      byteLength: entry.byteLength,
      record: entry.record,
    });
  }
  return entries;
}

async function buildSessionTranscriptIndex(
  filePath: string,
  stat: fs.Stats,
): Promise<SessionTranscriptIndex> {
  const rawEntries: IndexedRawEntry[] = [];
  const byId = new Map<string, IndexedRawEntry>();
  let hasTreeEntries = false;
  let leafId: string | undefined;

  await visitTranscriptJsonLines(filePath, (line, offset, byteLength) => {
    if (!line.trim()) {
      return;
    }
    if (byteLength > MAX_TRANSCRIPT_INDEX_PARSE_LINE_BYTES) {
      const rawEntry = buildOversizedIndexedRawEntry({ line, offset, byteLength });
      if (!rawEntry) {
        return;
      }
      rawEntries.push(rawEntry);
      if (rawEntry.id) {
        byId.set(rawEntry.id, rawEntry);
        if (isTreeTranscriptRecord(rawEntry.record)) {
          hasTreeEntries = true;
          leafId = rawEntry.id;
        }
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isIndexableTranscriptRecord(parsed)) {
      return;
    }
    const id = normalizeOptionalString(parsed.id);
    const parentId =
      parsed.parentId === null ? null : (normalizeOptionalString(parsed.parentId) ?? undefined);
    const rawEntry: IndexedRawEntry = {
      ...(id ? { id } : {}),
      ...(parentId !== undefined ? { parentId } : {}),
      offset,
      byteLength,
      record: parsed,
    };
    rawEntries.push(rawEntry);
    if (id) {
      byId.set(id, rawEntry);
      if (isTreeTranscriptRecord(parsed)) {
        hasTreeEntries = true;
        leafId = id;
      }
    }
  });

  const activeRawEntries = hasTreeEntries ? buildActiveTreeEntries({ byId, leafId }) : rawEntries;
  return {
    filePath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hasTreeEntries,
    ...(leafId ? { leafId } : {}),
    entries: toIndexedEntries(activeRawEntries),
  };
}

export async function readSessionTranscriptIndex(
  filePath: string,
  opts: ReadSessionTranscriptIndexOptions = {},
): Promise<SessionTranscriptIndex | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    transcriptIndexCache.delete(filePath);
    return null;
  }
  if (!stat.isFile()) {
    transcriptIndexCache.delete(filePath);
    return null;
  }
  if (opts.cache === "skip") {
    return await buildSessionTranscriptIndex(filePath, stat);
  }
  const cached = transcriptIndexCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return touchCachedIndex(filePath, cached);
  }
  const inFlight = transcriptIndexBuilds.get(filePath);
  if (inFlight && inFlight.mtimeMs === stat.mtimeMs && inFlight.size === stat.size) {
    return await inFlight.promise;
  }
  const promise = buildSessionTranscriptIndex(filePath, stat);
  transcriptIndexBuilds.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    promise,
  });
  const index = await promise.finally(() => {
    const current = transcriptIndexBuilds.get(filePath);
    if (current?.promise === promise) {
      transcriptIndexBuilds.delete(filePath);
    }
  });
  setCachedIndex(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    index,
  });
  return index;
}
