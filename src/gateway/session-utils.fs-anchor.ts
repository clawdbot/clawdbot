import { materializeSessionArchiveForRead } from "../config/sessions/archive-compression.js";
import { resolveSessionTranscriptResetArchiveCandidatesAsync } from "./session-transcript-files.fs.js";
import { readSessionTranscriptIndex } from "./session-transcript-index.fs.js";
import {
  findExistingTranscriptPath,
  indexedTranscriptEntryToMessages,
  type ReadRecentSessionMessagesResult,
} from "./session-utils.fs.js";

type ReadSessionMessagesAroundIdOptions = {
  messageId: string;
  maxMessages: number;
  allowResetArchiveFallback?: boolean;
};

type ReadSessionMessagesAroundIdResult = ReadRecentSessionMessagesResult & {
  found: boolean;
  hasOverreadContext: boolean;
  offset: number;
};

export function resolveSessionMessageAnchorBounds(
  records: readonly { id?: string }[],
  messageId: string,
  maxMessages: number,
): { endExclusive: number; offset: number; start: number } | undefined {
  const anchorIndex = records.findIndex((record) => record.id === messageId);
  if (anchorIndex === -1) {
    return undefined;
  }
  const pageSize = Math.max(1, Math.floor(maxMessages));
  const newerMessages = Math.floor(pageSize / 2);
  const olderMessages = pageSize - newerMessages - 1;
  const latestStart = Math.max(0, records.length - pageSize);
  const start = Math.min(Math.max(0, anchorIndex - olderMessages), latestStart);
  const endExclusive = Math.min(records.length, start + pageSize);
  return { endExclusive, offset: records.length - endExclusive, start };
}

export async function readSessionMessagesAroundIdWithStatsAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  opts: ReadSessionMessagesAroundIdOptions,
  agentId?: string,
): Promise<ReadSessionMessagesAroundIdResult> {
  const activePath = findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
  const archivePaths =
    opts.allowResetArchiveFallback === true
      ? await resolveSessionTranscriptResetArchiveCandidatesAsync(
          sessionId,
          storePath,
          sessionFile,
          agentId,
        )
      : [];
  const paths = [activePath, ...archivePaths].filter(
    (candidate, index, candidates): candidate is string =>
      candidate !== null && candidates.indexOf(candidate) === index,
  );
  let activeTotalMessages = 0;
  for (const candidatePath of paths) {
    let filePath: string;
    try {
      filePath = materializeSessionArchiveForRead(candidatePath);
    } catch {
      continue;
    }
    const index = await readSessionTranscriptIndex(filePath);
    if (!index) {
      continue;
    }
    if (candidatePath === activePath) {
      activeTotalMessages = index.entries.length;
    }
    const bounds = resolveSessionMessageAnchorBounds(
      index.entries,
      opts.messageId,
      opts.maxMessages,
    );
    if (!bounds) {
      continue;
    }
    const readStart = Math.max(0, bounds.start - 1);
    return {
      found: true,
      hasOverreadContext: readStart < bounds.start,
      messages: index.entries
        .slice(readStart, bounds.endExclusive)
        .flatMap((entry) => indexedTranscriptEntryToMessages(entry)),
      offset: bounds.offset,
      totalMessages: index.entries.length,
      transcriptPath: filePath,
    };
  }
  return {
    found: false,
    hasOverreadContext: false,
    messages: [],
    offset: 0,
    totalMessages: activeTotalMessages,
    ...(activePath ? { transcriptPath: activePath } : {}),
  };
}
