import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionEntry } from "../config/sessions.js";
import {
  dropPreSessionStartAnnouncePairs,
  isHeartbeatHistoryTurnBoundaryMessage,
  projectChatDisplayMessagesWithState,
} from "./chat-display-projection.js";
import { resolveCurrentUserProfileDisplay } from "./current-user-profile-display.js";
import {
  readRecentSessionMessagesWithStatsAsync,
  readSessionMessagesPageWithStatsAsync,
  type ReadRecentSessionMessagesResult,
  type SessionTranscriptReadScope,
} from "./session-transcript-readers.js";

const SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_MESSAGES = 8_000;
const SILENT_CHAT_HISTORY_TAIL_SCAN_CHUNK_MESSAGES = 100;
const SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_CHUNK_MESSAGES = 400;

export function readChatHistoryMessageSeq(message: unknown): number | undefined {
  const metadata = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
  return asPositiveSafeInteger(metadata?.seq);
}

export function capOffsetChatHistoryProjectedMessages(messages: unknown[], max: number): unknown[] {
  if (messages.length <= max) {
    return messages;
  }
  const start = Math.max(0, messages.length - max);
  const boundarySeq = readChatHistoryMessageSeq(messages[start]);
  if (boundarySeq === undefined) {
    return messages.slice(start);
  }
  // Numeric cursors resume at transcript records, so projected siblings stay together.
  let safeStart = start;
  while (safeStart > 0 && readChatHistoryMessageSeq(messages[safeStart - 1]) === boundarySeq) {
    safeStart--;
  }
  return messages.slice(safeStart);
}

export function dropChatHistoryOverreadContextMessage(
  messages: unknown[],
  contextMessage: unknown,
): unknown[] {
  if (contextMessage === undefined) {
    return messages;
  }
  const index = messages.indexOf(contextMessage);
  return index < 0 ? messages : [...messages.slice(0, index), ...messages.slice(index + 1)];
}

export type IncrementalChatHistoryTail = {
  overreadContextMessage: unknown;
  projection: ReturnType<typeof projectChatDisplayMessagesWithState>;
  projected: unknown[];
  rawMessages: unknown[];
  rawPageMessages: number;
  readPage: ReadRecentSessionMessagesResult;
};

/** Scans indexed transcript records until one bounded visible history page is filled. */
export async function readIncrementalChatHistoryTail(params: {
  entry: SessionEntry | undefined;
  readScope: SessionTranscriptReadScope;
  effectiveMaxChars: number;
  max: number;
  maxBytes: number;
  offset?: number;
  preserveProjectionContext?: boolean;
}): Promise<IncrementalChatHistoryTail> {
  const offset = params.offset ?? 0;
  const rawHistoryWindowMessages = Math.max(1, Math.floor(params.max)) * 20 + 20;
  // Sequence-cursor transports group tool results and derived mirrors together,
  // so their initial read keeps the established wider projection context.
  const initialMessages =
    params.preserveProjectionContext && offset === 0
      ? rawHistoryWindowMessages
      : Math.min(rawHistoryWindowMessages, Math.max(1, offset === 0 ? params.max * 3 : params.max));
  const readPage =
    offset === 0
      ? await readRecentSessionMessagesWithStatsAsync(params.readScope, {
          maxMessages: initialMessages + 1,
          maxLines: initialMessages + 1,
          maxBytes: Math.max(params.maxBytes * 2, 1024 * 1024),
          allowResetArchiveFallback: true,
        })
      : await readSessionMessagesPageWithStatsAsync(params.readScope, {
          offset,
          maxMessages: initialMessages + 1,
          allowResetArchiveFallback: true,
        });
  const sessionStartedAt =
    typeof params.entry?.sessionStartedAt === "number" ? params.entry.sessionStartedAt : undefined;
  let rawPageMessages = Math.min(
    initialMessages,
    Math.max(readPage.messages.length, readPage.totalMessages > offset ? 1 : 0),
  );
  let overreadContextMessage =
    readPage.messages.length > initialMessages ? readPage.messages[0] : undefined;
  let rawMessages = dropChatHistoryOverreadContextMessage(
    readPage.messages,
    overreadContextMessage,
  );
  const project = () => {
    const filteredRawMessages =
      sessionStartedAt === undefined
        ? rawMessages
        : dropChatHistoryOverreadContextMessage(
            dropPreSessionStartAnnouncePairs(
              overreadContextMessage === undefined
                ? rawMessages
                : [overreadContextMessage, ...rawMessages],
              sessionStartedAt,
            ),
            overreadContextMessage,
          );
    const projection = projectChatDisplayMessagesWithState(filteredRawMessages, {
      includeCommentaryFallbacks: true,
      maxChars: params.effectiveMaxChars,
      resolveCurrentUserProfileDisplay,
      turnBoundaryPending: isHeartbeatHistoryTurnBoundaryMessage(overreadContextMessage),
    });
    const projected =
      offset === 0
        ? projection.messages.length > params.max
          ? projection.messages.slice(-params.max)
          : projection.messages
        : capOffsetChatHistoryProjectedMessages(projection.messages, params.max);
    return { filteredRawMessages, projected, projection };
  };
  let result = project();
  let scanLimit = rawHistoryWindowMessages;
  let scannedBytes = 0;
  let nextChunkMessages = SILENT_CHAT_HISTORY_TAIL_SCAN_CHUNK_MESSAGES;
  while (offset + rawPageMessages < readPage.totalMessages) {
    if (result.projected.length >= params.max) {
      break;
    }
    if (rawPageMessages >= rawHistoryWindowMessages) {
      scanLimit = rawHistoryWindowMessages + SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_MESSAGES;
    }
    if (rawPageMessages >= scanLimit) {
      break;
    }
    const chunkMessages = Math.min(nextChunkMessages, scanLimit - rawPageMessages);
    const page = await readSessionMessagesPageWithStatsAsync(params.readScope, {
      offset: offset + rawPageMessages,
      maxMessages: chunkMessages + 1,
      allowResetArchiveFallback: true,
    });
    if (page.messages.length === 0) {
      break;
    }
    // One older context row preserves stale-pair and heartbeat boundaries across chunks.
    const contextMessage = page.messages.length > chunkMessages ? page.messages[0] : undefined;
    rawPageMessages += page.messages.length - (contextMessage === undefined ? 0 : 1);
    rawMessages = dropChatHistoryOverreadContextMessage(
      [...page.messages, ...rawMessages],
      contextMessage,
    );
    overreadContextMessage = contextMessage;
    result = project();
    scannedBytes += Buffer.byteLength(JSON.stringify(page.messages), "utf8");
    if (rawPageMessages > rawHistoryWindowMessages && scannedBytes >= params.maxBytes) {
      break;
    }
    // Grow sparse scans geometrically while bounding each indexed page's allocation.
    nextChunkMessages = Math.min(
      nextChunkMessages * 2,
      SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_CHUNK_MESSAGES,
    );
  }
  return {
    overreadContextMessage,
    projected: result.projected,
    projection: result.projection,
    rawMessages: result.filteredRawMessages,
    rawPageMessages,
    readPage,
  };
}
