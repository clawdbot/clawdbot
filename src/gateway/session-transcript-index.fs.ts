import fs from "node:fs";
import readline from "node:readline";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { TranscriptDisplayPosition } from "../chat/transcript-display-position.js";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { selectSessionTranscriptActiveEntries } from "../config/sessions/transcript-tree.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import {
  createTranscriptDisplayPosition,
  createTranscriptDisplaySource,
} from "../sessions/transcript-display-position.js";
import { isVisibleTranscriptRecord } from "../sessions/transcript-visible-record.js";
import {
  parseTranscriptRecord,
  type TranscriptRecord,
} from "./session-transcript-record-parser.js";

export type IndexedTranscriptEntry = TranscriptRecord & {
  seq: number;
  transcriptPosition: TranscriptDisplayPosition;
};

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

async function buildSessionTranscriptIndex(
  filePath: string,
  displaySource: string,
  sessionId: string,
): Promise<SessionTranscriptIndex> {
  const records: Array<TranscriptRecord & { rawSeq: number }> = [];
  const rawSeqById = new Map<string, number>();
  const handle = await fs.promises.open(filePath, "r");
  try {
    const stat = await handle.stat();
    assertArchiveTranscriptSource(filePath, stat, displaySource, sessionId);
    // The handle pins the scan across path replacement and owns stream shutdown on failure.
    const stream = fs.createReadStream(filePath, {
      encoding: "utf8",
      fd: handle,
      autoClose: false,
    });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const record = parseTranscriptRecord(line);
        if (record) {
          const rawSeq = records.length + 1;
          records.push({ ...record, rawSeq });
          if (record.id) {
            // Capture physical cuts before branch/reset selection removes their control rows.
            rawSeqById.set(record.id, rawSeq);
          }
        }
      }
      const finalStat = await handle.stat();
      assertArchiveTranscriptSource(filePath, finalStat, displaySource, sessionId);
    } finally {
      lines.close();
    }
  } finally {
    await handle.close();
  }
  const entries = selectArchiveTranscriptEntries(records)
    .filter((entry) => isVisibleTranscriptRecord(entry.record))
    .map((entry, index): IndexedTranscriptEntry => ({
      byteLength: entry.byteLength,
      id: entry.id,
      recoveredImageData: entry.recoveredImageData,
      record: entry.record,
      seq: index + 1,
      transcriptPosition: createTranscriptDisplayPosition(
        displaySource,
        entry.rawSeq,
        entry.record.message,
        (id) => rawSeqById.get(id),
      ),
    }));
  return {
    entries,
    byId: new Map(entries.flatMap((entry) => (entry.id ? [[entry.id, entry] as const] : []))),
    displaySource,
  };
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
