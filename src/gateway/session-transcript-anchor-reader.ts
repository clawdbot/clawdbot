import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.js";
import { readSessionTranscriptHistoryAnchorPage } from "../config/sessions/session-accessor.sqlite-history-events.js";
import { projectTranscriptEntryMessage } from "./session-transcript-message.js";
import {
  resolveTranscriptReadTarget,
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
  const page = readSessionTranscriptHistoryAnchorPage(toTranscriptReadScope(target), opts);
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
      const message = projectTranscriptEntryMessage(entry.event, entry.seq);
      return message === undefined ? [] : [message];
    }),
    offset: page.offset,
    totalMessages: page.totalMessages,
    transcriptPath: target.sessionFile,
  };
}
