import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

const TRANSCRIPT_INDEX_READ_CHUNK_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_INDEX_CACHE_ENTRIES = 256;

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
      return [];
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
    if (isTreeTranscriptRecord(parsed) && id) {
      hasTreeEntries = true;
      leafId = id;
      byId.set(id, rawEntry);
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
