// Filesystem transcript indexer.
// Streams JSONL transcript files into byte-offset indexes for history paging.
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptActiveEntries,
} from "../config/sessions/transcript-tree.js";
import {
  extractJsonNullableStringFieldPrefix,
  extractJsonNumberFieldPrefix,
  extractJsonStringFieldPrefix,
  readNonBlankStringPreservingWhitespace,
} from "./session-transcript-json.js";

const TRANSCRIPT_INDEX_READ_CHUNK_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_INDEX_CACHE_ENTRIES = 256;
const MAX_TRANSCRIPT_INDEX_PARSE_LINE_BYTES = 256 * 1024;
const OVERSIZED_TRANSCRIPT_METADATA_PREFIX_CHARS = 64 * 1024;
const TRANSCRIPT_OVERSIZED_MESSAGE_PLACEHOLDER = "[chat.history omitted: message too large]";

type ParsedTranscriptRecord = Record<string, unknown>;

/** Visible transcript entry plus its byte range in the JSONL file. */
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
  leafId?: string | null;
  entries: IndexedTranscriptEntry[];
  allEntries: IndexedTranscriptEntry[];
};

type IndexedRawEntry = {
  id?: string;
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
  view?: "active" | "all";
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

async function yieldTranscriptIndexScan(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
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

function selectTranscriptIndexView(
  index: SessionTranscriptIndex,
  view: ReadSessionTranscriptIndexOptions["view"],
): SessionTranscriptIndex {
  return view === "all" ? { ...index, entries: index.allEntries } : index;
}

function isIndexableTranscriptRecord(record: unknown): record is ParsedTranscriptRecord {
  return Boolean(record && typeof record === "object" && !Array.isArray(record));
}

function isVisibleTranscriptRecord(record: ParsedTranscriptRecord): boolean {
  return Boolean(record.message) || record.type === "compaction";
}

function buildOversizedIndexedRawEntry(params: {
  line: string;
  offset: number;
  byteLength: number;
}): IndexedRawEntry | null {
  // Oversized lines may contain huge message arrays, so recover only metadata
  // from a bounded prefix and synthesize a visible placeholder record.
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
      // Yield between chunks so a large transcript scan does not monopolize the
      // gateway event loop while chat/session traffic is still flowing.
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
    const id = readNonBlankStringPreservingWhitespace(parsed.id);
    const rawEntry: IndexedRawEntry = {
      ...(id ? { id } : {}),
      offset,
      byteLength,
      record: parsed,
    };
    rawEntries.push(rawEntry);
  });

  const tree = scanSessionTranscriptTree(rawEntries.map((entry) => entry.record));
  const activeRawEntries = selectSessionTranscriptActiveEntries({
    entries: rawEntries,
    recordOf: (entry) => entry.record,
    tree,
  });
  return {
    filePath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hasTreeEntries: tree.hasExplicitLeafUpdate,
    ...(tree.hasExplicitLeafUpdate ? { leafId: tree.leafId } : {}),
    entries: toIndexedEntries(activeRawEntries),
    allEntries: toIndexedEntries(rawEntries),
  };
}

/** Reads or builds the visible transcript index for a JSONL session file. */
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
    return selectTranscriptIndexView(await buildSessionTranscriptIndex(filePath, stat), opts.view);
  }
  const cached = transcriptIndexCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return selectTranscriptIndexView(touchCachedIndex(filePath, cached), opts.view);
  }
  const inFlight = transcriptIndexBuilds.get(filePath);
  if (inFlight && inFlight.mtimeMs === stat.mtimeMs && inFlight.size === stat.size) {
    return selectTranscriptIndexView(await inFlight.promise, opts.view);
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
  return selectTranscriptIndexView(index, opts.view);
}
