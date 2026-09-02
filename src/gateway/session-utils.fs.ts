// Filesystem session history readers.
// Parses transcript JSONL files for messages, previews, counts, and usage metadata.
import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import {
  resolveIntegerOption,
  resolveNonNegativeIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import { materializeSessionArchiveForRead } from "../config/sessions/archive-compression.js";
import type { TranscriptEvent } from "../config/sessions/session-accessor.js";
import { streamSessionTranscriptLines } from "../config/sessions/transcript-stream.js";
import { readFileWindowFully } from "../infra/file-read.js";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
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
  assertArchiveTranscriptSource,
  isVisibleTranscriptRecord,
  readSessionTranscriptIndex,
  selectArchiveTranscriptEntries,
  type IndexedTranscriptEntry,
  type SessionTranscriptIndex,
} from "./session-transcript-index.fs.js";
import { projectTranscriptEntryMessage } from "./session-transcript-message.js";
import {
  isOversizedTranscriptLine,
  MAX_TRANSCRIPT_PARSE_LINE_BYTES,
  parseTranscriptRecord,
} from "./session-transcript-record-parser.js";
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
  displaySource?: string;
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
  opts: ReadRecentSessionMessagesOptions,
  displaySource: string,
  sessionId: string,
): Promise<string[]> {
  const { maxBytes, maxLines } = normalizeRecentSessionReadOptions(opts);
  const handle = await fs.promises.open(filePath, "r");
  try {
    const stat = await handle.stat();
    assertArchiveTranscriptSource(filePath, stat, displaySource, sessionId);
    const readLen = Math.min(stat.size, maxBytes);
    const readStart = Math.max(0, stat.size - readLen);
    const buffer = Buffer.alloc(readLen);
    const bytesRead = await readFileWindowFully(handle, buffer, readStart);
    const finalStat = await handle.stat();
    assertArchiveTranscriptSource(filePath, finalStat, displaySource, sessionId);
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

function parseRecentTranscriptTailSnapshot(
  lines: string[],
  maxMessages: number,
  index: SessionTranscriptIndex,
): { messages: unknown[]; transcriptEvents: TranscriptEvent[] } {
  const entries = lines.flatMap((line) => {
    const entry = parseTranscriptRecord(line);
    return entry ? [entry] : [];
  });
  const selected = selectArchiveTranscriptEntries(entries, true);
  const recent = selected
    .filter((entry) => isVisibleTranscriptRecord(entry.record))
    .slice(-maxMessages);
  const firstSeq = Math.max(1, index.entries.length - recent.length + 1);
  return {
    messages: recent.flatMap((entry, offset) => {
      // Reuse indexed placement, never indexed payloads: the tail's byte/line bounds still own this read.
      const indexed = entry.id ? index.byId.get(entry.id) : undefined;
      const message = projectTranscriptEntryMessage(
        entry.record,
        indexed?.seq ?? firstSeq + offset,
        indexed?.transcriptPosition,
      );
      return message ? [message] : [];
    }),
    transcriptEvents: selected.map((entry) => entry.record),
  };
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
    if (opts.mode === "recent") {
      const snapshot = await this.readRecentWithStats(opts);
      return { messages: snapshot.messages, transcriptPath: snapshot.transcriptPath };
    }
    const artifact = await this.resolveArtifact(opts);
    if (!artifact) {
      return { messages: [] };
    }
    const index = await readSessionTranscriptIndex(artifact.path, this.scope.sessionId);
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
    const entry = (await readSessionTranscriptIndex(artifact.path, this.scope.sessionId))?.byId.get(
      messageId,
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
    const transcriptIndex = await readSessionTranscriptIndex(artifact.path, this.scope.sessionId);
    const totalMessages = transcriptIndex?.entries.length ?? 0;
    const normalized = normalizeRecentSessionReadOptions(opts);
    const snapshot =
      normalized.maxMessages === 0 || !transcriptIndex
        ? { messages: [], transcriptEvents: [] }
        : await readRecentSessionSnapshotFromPathAsync(
            artifact.path,
            normalized,
            transcriptIndex,
            this.scope.sessionId,
          );
    return {
      displaySource: transcriptIndex?.displaySource,
      messages: snapshot.messages,
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
    const index = await readSessionTranscriptIndex(artifact.path, this.scope.sessionId);
    if (!index) {
      return { messages: [], totalMessages: 0, transcriptPath: artifact.path };
    }
    const totalMessages = index.entries.length;
    const offset = Math.min(resolveNonNegativeIntegerOption(opts.offset, 0), totalMessages);
    const endExclusive = Math.max(0, totalMessages - offset);
    const start = Math.max(0, endExclusive - resolveNonNegativeIntegerOption(opts.maxMessages, 0));
    const entries = index.entries.slice(start, endExclusive);
    return {
      displaySource: index.displaySource,
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
    let displaySource: string | undefined;
    for (const artifact of artifacts) {
      const index = await readSessionTranscriptIndex(artifact.path, this.scope.sessionId);
      if (!index) {
        continue;
      }
      displaySource ??= index.displaySource;
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
        displaySource: index.displaySource,
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
      displaySource,
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
  index: SessionTranscriptIndex,
  sessionId: string,
): Promise<{ messages: unknown[]; transcriptEvents: TranscriptEvent[] }> {
  const lines = await readRecentTranscriptTailLinesAsync(
    filePath,
    opts,
    index.displaySource,
    sessionId,
  );
  return parseRecentTranscriptTailSnapshot(lines, opts.maxMessages, index);
}

function indexedTranscriptEntryToMessage(entry: IndexedTranscriptEntry): unknown {
  return projectTranscriptEntryMessage(entry.record, entry.seq, entry.transcriptPosition);
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
