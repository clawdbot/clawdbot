import {
  readSessionTranscriptMessageAnchorPage,
  type SessionTranscriptReadScope,
} from "../config/sessions/session-accessor.js";
import {
  isSqliteReadTarget,
  resolveTranscriptReadTarget,
  sqliteMessageEventWithSeq,
  toTranscriptReadScope,
  type ReadRecentSessionMessagesResult,
} from "./session-transcript-readers.js";
import { readSessionMessagesAroundIdWithStatsAsync as readSessionMessagesAroundIdWithStatsAsyncFile } from "./session-utils.fs-anchor.js";

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
    const page = readSessionTranscriptMessageAnchorPage(toTranscriptReadScope(target), opts);
    if (!page.found) {
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
        totalMessages: page.totalMessages,
        transcriptPath: target.sessionFile,
      };
    }
    return {
      found: true,
      hasOverreadContext: page.hasOverreadContext,
      messages: page.events.flatMap((entry) => {
        const message = sqliteMessageEventWithSeq(entry);
        return message === undefined ? [] : [message];
      }),
      offset: page.offset,
      totalMessages: page.totalMessages,
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
