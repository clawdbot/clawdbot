import {
  readSessionTranscriptMessageAnchorPage,
  type SessionTranscriptReadScope,
} from "../config/sessions/session-accessor.js";
import {
  resolveTranscriptReadTarget,
  sqliteMessageEventWithSeq,
  toTranscriptReadScope,
  type ReadRecentSessionMessagesResult,
} from "./session-transcript-readers.js";
import { ArchivedTranscriptReader } from "./session-utils.fs.js";

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
  const page = readSessionTranscriptMessageAnchorPage(toTranscriptReadScope(target), opts);
  if (!page.found) {
    if (opts.allowResetArchiveFallback === true) {
      return await new ArchivedTranscriptReader({
        agentId: target.agentId,
        sessionFile,
        sessionId: target.sessionId,
        storePath: target.storePath,
      }).readAroundId({ ...opts, resetArchiveOnly: true });
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
