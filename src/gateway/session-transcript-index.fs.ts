import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { TranscriptDisplayPosition } from "../chat/transcript-display-position.js";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { selectSessionTranscriptActiveEntries } from "../config/sessions/transcript-tree.js";
import { readFileWindowFully } from "../infra/file-read.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { readNestedToolActivity } from "../sessions/nested-tool-activity.js";
import {
  createTranscriptDisplayPositionFromActivity,
  createTranscriptDisplaySource,
  type TranscriptDisplayActivity,
} from "../sessions/transcript-display-position.js";
import { isVisibleTranscriptRecord } from "../sessions/transcript-visible-record.js";
import {
  parseTranscriptRecord,
  type TranscriptRecord,
} from "./session-transcript-record-parser.js";

export type IndexedTranscriptEntry = {
  id?: string;
  /** Selection sometimes compares the raw ID, including blank strings. */
  rawId?: string;
  offset: number;
  /** Physical bytes, distinct from the parser's decoded/sanitized byteLength. */
  length: number;
  seq: number;
  transcriptPosition: TranscriptDisplayPosition;
};

export type MaterializedTranscriptEntry = TranscriptRecord & IndexedTranscriptEntry;

export type SessionTranscriptIndex = {
  entries: IndexedTranscriptEntry[];
  byId: Map<string, IndexedTranscriptEntry>;
  displaySource: string;
};

type CachedTranscriptIndex = {
  identity: string;
  value: Promise<SessionTranscriptIndex>;
};

const transcriptIndexes = new Map<string, CachedTranscriptIndex>();
const MAX_TRANSCRIPT_INDEXES = 256;
const ARCHIVE_READ_BYTES = 64 * 1024;
const ARCHIVE_BATCH_BYTES = 1024 * 1024;

function transcriptArtifactDisplaySource(filePath: string, stat: fs.Stats): string {
  // Inode/ctime distinguish replacement or rewrite even when size and mtime are preserved.
  const identity = `${stat.dev}:${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}`;
  return createTranscriptDisplaySource(["archive", filePath, identity]);
}

export function assertArchiveTranscriptSource(
  filePath: string,
  stat: fs.Stats,
  displaySource: string,
  sessionId: string,
): void {
  if (transcriptArtifactDisplaySource(filePath, stat) !== displaySource) {
    throw new SessionTranscriptProjectionUnavailableError(sessionId);
  }
}

export function selectArchiveTranscriptEntries<T extends TranscriptRecord>(
  records: T[],
  failClosedOnInvalidLeafControl = false,
): T[] {
  const entries = selectSessionTranscriptActiveEntries({
    entries: records,
    recordOf: (entry) => entry.record,
    failClosedOnInvalidLeafControl,
  });
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
          const role = asOptionalRecord(record.message)?.role;
          return role === "user" || role === "assistant";
        });
  return [...kept, ...entries.slice(boundaryIndex)];
}

async function* readArchiveLines(filePath: string, handle: FileHandle) {
  const stream = fs.createReadStream(filePath, {
    fd: handle,
    autoClose: false,
    highWaterMark: ARCHIVE_READ_BYTES,
  });
  let offset = 0;
  let length = 0;
  let afterCr = false;
  const fragments: Buffer[] = [];
  try {
    // SAFETY: This ReadStream emits raw Buffers; it has no encoding or setEncoding call.
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let start = 0;
      // Match readline's CR, LF and CRLF semantics, even across read boundaries.
      if (afterCr && chunk[0] === 10) {
        start = 1;
        offset++;
      }
      afterCr = false;
      while (start < chunk.length) {
        const lf = chunk.indexOf(10, start);
        const cr = chunk.indexOf(13, start);
        const end = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
        if (end < 0) {
          fragments.push(chunk.subarray(start));
          length += chunk.length - start;
          break;
        }
        const last = chunk.subarray(start, end);
        length += last.length;
        const line = fragments.length ? Buffer.concat([...fragments, last], length) : last;
        yield { line: line.toString("utf8"), offset, length };
        fragments.length = 0;
        offset += length + 1;
        length = 0;
        start = end + 1;
        if (chunk[end] === 13) {
          if (chunk[start] === 10) {
            start++;
            offset++;
          } else {
            afterCr = start === chunk.length;
          }
        }
      }
    }
    if (length > 0) {
      yield { line: Buffer.concat(fragments, length).toString("utf8"), offset, length };
    }
  } finally {
    // Destroy closes the descriptor even with autoClose:false. A completed scan
    // leaves it with the outer owner for its final identity check and close.
    if (!stream.readableEnded) {
      stream.destroy();
    }
  }
}

function archiveNavigationRecord(record: Record<string, unknown>): Record<string, unknown> {
  const navigation: Record<string, unknown> = {};
  for (const key of [
    "id",
    "type",
    "parentId",
    "targetId",
    "appendParentId",
    "appendMode",
    "firstKeptEntryId",
  ]) {
    if (Object.hasOwn(record, key)) {
      const value = record[key];
      navigation[key] = typeof value === "string" || value === null ? value : false;
    }
  }
  // The tree/reset selector needs message presence and role, never its payload.
  const role = asOptionalRecord(record.message)?.role;
  navigation.message = record.message
    ? { role: role === "user" || role === "assistant" ? role : undefined }
    : false;
  return navigation;
}

async function buildSessionTranscriptIndex(
  filePath: string,
  displaySource: string,
  sessionId: string,
): Promise<SessionTranscriptIndex> {
  const records: Array<
    TranscriptRecord & {
      rawSeq: number;
      offset: number;
      length: number;
      activity?: TranscriptDisplayActivity;
    }
  > = [];
  const rawSeqById = new Map<string, number>();
  const handle = await fs.promises.open(filePath, "r");
  try {
    const stat = await handle.stat();
    assertArchiveTranscriptSource(filePath, stat, displaySource, sessionId);
    for await (const { line, offset, length } of readArchiveLines(filePath, handle)) {
      if (!line.trim()) {
        continue;
      }
      const record = parseTranscriptRecord(line);
      if (record) {
        const rawSeq = records.length + 1;
        const activity = readNestedToolActivity(record.record.message)?.details;
        records.push({
          ...record,
          record: archiveNavigationRecord(record.record),
          rawSeq,
          offset,
          length,
          ...(activity
            ? {
                activity: {
                  afterEntryId: activity.afterEntryId,
                  scopeId: activity.scopeId,
                  startOrder: activity.startOrder,
                },
              }
            : {}),
        });
        if (record.id) {
          // Capture physical cuts before branch/reset selection removes their control rows.
          rawSeqById.set(record.id, rawSeq);
        }
      }
    }
    const finalStat = await handle.stat();
    assertArchiveTranscriptSource(filePath, finalStat, displaySource, sessionId);
  } finally {
    await handle.close();
  }
  const entries = selectArchiveTranscriptEntries(records)
    .filter((entry) => isVisibleTranscriptRecord(entry.record))
    .map((entry, index): IndexedTranscriptEntry => ({
      id: entry.id,
      rawId: typeof entry.record.id === "string" ? entry.record.id : undefined,
      offset: entry.offset,
      length: entry.length,
      seq: index + 1,
      transcriptPosition: createTranscriptDisplayPositionFromActivity(
        displaySource,
        entry.rawSeq,
        entry.activity,
        (id) => rawSeqById.get(id),
      ),
    }));
  return {
    entries,
    byId: new Map(entries.flatMap((entry) => (entry.id ? [[entry.id, entry] as const] : []))),
    displaySource,
  };
}

/** Read selected payloads in bounded asynchronous batches; the cache owns no payload objects. */
export async function readIndexedTranscriptEntries(
  filePath: string,
  index: SessionTranscriptIndex,
  selected: readonly IndexedTranscriptEntry[],
  sessionId: string,
): Promise<MaterializedTranscriptEntry[]> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    assertArchiveTranscriptSource(filePath, await handle.stat(), index.displaySource, sessionId);
    const physical = selected
      .map((entry, order) => ({ entry, order }))
      .toSorted((left, right) => left.entry.offset - right.entry.offset);
    const result: MaterializedTranscriptEntry[] = [];
    for (let start = 0; start < physical.length;) {
      const first = physical[start]!.entry;
      let end = start + 1;
      let byteEnd = first.offset + first.length;
      while (end < physical.length) {
        const next = physical[end]!.entry;
        if (next.offset + next.length - first.offset > ARCHIVE_BATCH_BYTES) {
          break;
        }
        byteEnd = Math.max(byteEnd, next.offset + next.length);
        end++;
      }
      // One oversized record still follows the existing parser's recovery contract.
      const buffer = Buffer.allocUnsafe(byteEnd - first.offset);
      if ((await readFileWindowFully(handle, buffer, first.offset)) !== buffer.length) {
        throw new SessionTranscriptProjectionUnavailableError(sessionId);
      }
      for (let position = start; position < end; position++) {
        const { entry, order } = physical[position]!;
        const relative = entry.offset - first.offset;
        const parsed = parseTranscriptRecord(
          buffer.toString("utf8", relative, relative + entry.length),
        );
        if (!parsed) {
          throw new SessionTranscriptProjectionUnavailableError(sessionId);
        }
        result[order] = { ...entry, ...parsed };
      }
      start = end;
    }
    assertArchiveTranscriptSource(filePath, await handle.stat(), index.displaySource, sessionId);
    return result;
  } finally {
    await handle.close();
  }
}

export async function readSessionTranscriptIndex(
  filePath: string,
  sessionId: string,
): Promise<SessionTranscriptIndex | null> {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    transcriptIndexes.delete(filePath);
    return null;
  }
  const identity = transcriptArtifactDisplaySource(filePath, stat);
  let cached = transcriptIndexes.get(filePath);
  if (cached?.identity !== identity) {
    cached = { identity, value: buildSessionTranscriptIndex(filePath, identity, sessionId) };
  }
  transcriptIndexes.delete(filePath);
  transcriptIndexes.set(filePath, cached);
  pruneMapToMaxSize(transcriptIndexes, MAX_TRANSCRIPT_INDEXES);
  try {
    return await cached.value;
  } catch (error) {
    if (transcriptIndexes.get(filePath) === cached) {
      transcriptIndexes.delete(filePath);
    }
    throw error;
  }
}
