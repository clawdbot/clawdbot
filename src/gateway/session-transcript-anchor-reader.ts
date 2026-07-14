import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.js";
import {
  isSqliteReadTarget,
  readSqliteMessageRecords,
  resolveTranscriptReadTarget,
  sqliteRecordMessageWithSeq,
  type ReadRecentSessionMessagesResult,
} from "./session-transcript-readers.js";
import {
  readSessionMessagesAroundIdWithStatsAsync as readSessionMessagesAroundIdWithStatsAsyncFile,
  resolveSessionMessageAnchorBounds,
} from "./session-utils.fs-anchor.js";

type ReadSessionMessagesAroundIdResult = ReadRecentSessionMessagesResult & {
  found: boolean;
  hasOverreadContext: boolean;
  offset: number;
};

/** Reads one message-id-anchored page from a single transcript snapshot. */
export async function readSessionMessagesAroundIdWithStatsAsync(
  scope: SessionTranscriptReadScope,
  opts: { messageId: string; maxMessages: number; allowResetArchiveFallback?: boolean },
): Promise<ReadSessionMessagesAroundIdResult> {
  const target = resolveTranscriptReadTarget(scope);
  const sessionFile =
    !scope.sessionFile &&
    scope.sessionEntry?.sessionId &&
    scope.sessionEntry.sessionId !== scope.sessionId
      ? undefined
      : target.sessionFile;
  if (isSqliteReadTarget(target)) {
    const records = await readSqliteMessageRecords(target);
    const bounds = resolveSessionMessageAnchorBounds(records, opts.messageId, opts.maxMessages);
    if (!bounds) {
      if (opts.allowResetArchiveFallback === true) {
        return await readSessionMessagesAroundIdWithStatsAsyncFile(
          target.sessionId,
          target.storePath,
          sessionFile,
          opts,
          target.agentId,
        );
      }
      return {
        found: false,
        hasOverreadContext: false,
        messages: [],
        offset: 0,
        totalMessages: records.length,
        transcriptPath: target.sessionFile,
      };
    }
    const readStart = Math.max(0, bounds.start - 1);
    return {
      found: true,
      hasOverreadContext: readStart < bounds.start,
      messages: records.slice(readStart, bounds.endExclusive).map(sqliteRecordMessageWithSeq),
      offset: bounds.offset,
      totalMessages: records.length,
      transcriptPath: target.sessionFile,
    };
  }
  return await readSessionMessagesAroundIdWithStatsAsyncFile(
    target.sessionId,
    target.storePath,
    sessionFile,
    opts,
    target.agentId,
  );
}
