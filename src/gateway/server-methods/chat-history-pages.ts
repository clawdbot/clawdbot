import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveSessionTranscriptActiveLeafEntryId } from "../../config/sessions/session-accessor.js";
import {
  dropPreSessionStartAnnouncePairs,
  isHeartbeatHistoryTurnBoundaryMessage,
  projectChatDisplayMessages,
  projectChatDisplayMessagesWithState,
  augmentChatHistoryWithCanvasBlocks,
} from "../chat-display-projection.js";
import {
  readChatHistoryCliSessionImportSnapshot,
  resolveChatHistoryWithCliSessionImports,
  resolveClaudeCliBindingSessionId,
} from "../cli-session-history.js";
import { resolveCurrentUserProfileDisplay } from "../current-user-profile-display.js";
import {
  dropChatHistoryOverreadContextMessage,
  readChatHistoryMessageId,
  readChatHistoryRecoveryContext,
  readChatHistoryMessageSeq,
  readIncrementalChatHistoryTail,
  type IncrementalChatHistoryTail,
} from "../session-history-tail.js";
import { readSessionMessagesAroundIdWithStatsAsync } from "../session-transcript-anchor-reader.js";
import {
  readSessionMessagesAsync,
  type ReadRecentSessionMessagesResult,
} from "../session-transcript-readers.js";
import type { loadSessionEntry } from "../session-utils.js";

type ChatHistoryPage = {
  activeLeafEntryId?: string | null;
  deltaCursor?: string;
  messages: unknown[];
  responseOffset?: number;
  completeCliImport?: true;
  // Absent only for anchored (messageId) reads: the anchor may resolve a
  // reset-archive transcript that numeric offset cursors cannot address, so
  // anchored responses expose no paging metadata.
  pagination?: {
    offset: number;
    totalMessages: number;
    rawPageMessages: number;
    exhausted?: true;
  };
};

export function resolveChatHistoryNextOffset(params: {
  messages: unknown[];
  totalMessages: number;
  offset: number;
  rawPageMessages: number;
  replayOldestRecord?: boolean;
}): number {
  const oldestSeq = params.messages
    .map((message) => readChatHistoryMessageSeq(message))
    .find((seq): seq is number => typeof seq === "number");
  if (oldestSeq === undefined) {
    return params.offset + params.rawPageMessages;
  }
  const recordOffset = params.totalMessages - oldestSeq + 1;
  const replayOffset = recordOffset - 1;
  if (params.replayOldestRecord && replayOffset > params.offset) {
    return replayOffset;
  }
  // A replay cursor that does not advance strands every older transcript record.
  return Math.max(params.offset + 1, recordOffset);
}

export function shouldReplayOldestChatHistoryRecord(params: {
  projected: unknown[];
  bounded: unknown[];
}): boolean {
  const oldestSeq = params.bounded
    .map((message) => readChatHistoryMessageSeq(message))
    .find((seq): seq is number => typeof seq === "number");
  return (
    oldestSeq !== undefined &&
    params.bounded.filter((message) => readChatHistoryMessageSeq(message) === oldestSeq).length <
      params.projected.filter((message) => readChatHistoryMessageSeq(message) === oldestSeq).length
  );
}

function resolveChatHistoryActiveLeafEntryId(
  readPage: ReadRecentSessionMessagesResult,
): string | null {
  if (readPage.transcriptSource !== "active") {
    return null;
  }
  if (Object.hasOwn(readPage, "activeLeafEntryId")) {
    return readPage.activeLeafEntryId ?? null;
  }
  return resolveSessionTranscriptActiveLeafEntryId(readPage.transcriptEvents ?? []) ?? null;
}

/** Add checkpoint token metrics to the synthetic transcript compaction marker. */
export function enrichChatHistoryCompactionMarkers(
  messages: unknown[],
  entry: ReturnType<typeof loadSessionEntry>["entry"],
): unknown[] {
  const checkpoints = entry?.compactionCheckpoints;
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    return messages;
  }
  const checkpointByEntryId = new Map(
    checkpoints.flatMap((checkpoint) => {
      const entryId = checkpoint.postCompaction?.entryId;
      return typeof entryId === "string" && entryId ? [[entryId, checkpoint] as const] : [];
    }),
  );
  let changed = false;
  const enriched = messages.map((message) => {
    const record = asOptionalRecord(message);
    const metadata = asOptionalRecord(record?.["__openclaw"]);
    if (metadata?.kind !== "compaction" || typeof metadata.id !== "string") {
      return message;
    }
    const checkpoint = checkpointByEntryId.get(metadata.id);
    if (!checkpoint) {
      return message;
    }
    const tokensBefore = checkpoint.tokensBefore;
    const tokensAfter = checkpoint.tokensAfter;
    if (
      (typeof tokensBefore !== "number" || !Number.isFinite(tokensBefore)) &&
      (typeof tokensAfter !== "number" || !Number.isFinite(tokensAfter))
    ) {
      return message;
    }
    changed = true;
    return {
      ...record,
      __openclaw: {
        ...metadata,
        ...(typeof tokensBefore === "number" && Number.isFinite(tokensBefore)
          ? { tokensBefore }
          : {}),
        ...(typeof tokensAfter === "number" && Number.isFinite(tokensAfter) ? { tokensAfter } : {}),
      },
    };
  });
  return changed ? enriched : messages;
}

function resolveChatHistoryMessageGroup(
  messages: unknown[],
  index: number,
  messageCost: (message: unknown) => number,
): { start: number; end: number; cost: number } {
  const seq = readChatHistoryMessageSeq(messages[index]);
  let start = index;
  let end = index + 1;
  let cost = messageCost(messages[index]);
  if (seq === undefined) {
    return { start, end, cost };
  }
  while (start > 0 && readChatHistoryMessageSeq(messages[start - 1]) === seq) {
    start -= 1;
    cost += messageCost(messages[start]);
  }
  while (end < messages.length && readChatHistoryMessageSeq(messages[end]) === seq) {
    cost += messageCost(messages[end]);
    end += 1;
  }
  return { start, end, cost };
}

export function capChatHistoryAroundMessage(params: {
  messages: unknown[];
  messageId: string;
  maxCost: number;
  messageCost?: (message: unknown) => number;
}): unknown[] {
  const anchorIndex = params.messages.findIndex(
    (message) => readChatHistoryMessageId(message) === params.messageId,
  );
  if (anchorIndex === -1) {
    return [];
  }
  const messageCost = params.messageCost ?? (() => 1);
  const anchorGroup = resolveChatHistoryMessageGroup(params.messages, anchorIndex, messageCost);
  if (!(anchorGroup.cost <= params.maxCost)) {
    return [params.messages[anchorIndex]];
  }

  let { start, end, cost } = anchorGroup;
  let canGrowOlder = start > 0;
  let canGrowNewer = end < params.messages.length;
  while (canGrowOlder || canGrowNewer) {
    if (canGrowOlder) {
      const olderGroup = resolveChatHistoryMessageGroup(params.messages, start - 1, messageCost);
      if (cost + olderGroup.cost <= params.maxCost) {
        start = olderGroup.start;
        cost += olderGroup.cost;
      } else {
        canGrowOlder = false;
      }
    }
    canGrowOlder &&= start > 0;

    if (canGrowNewer) {
      const newerGroup = resolveChatHistoryMessageGroup(params.messages, end, messageCost);
      if (cost + newerGroup.cost <= params.maxCost) {
        end = newerGroup.end;
        cost += newerGroup.cost;
      } else {
        canGrowNewer = false;
      }
    }
    canGrowNewer &&= end < params.messages.length;
  }
  return params.messages.slice(start, end);
}

export async function readChatHistoryPage(params: {
  entry: ReturnType<typeof loadSessionEntry>["entry"];
  provider: string | undefined;
  sessionId: string | undefined;
  storePath: string | undefined;
  sessionAgentId: string;
  canonicalKey: string;
  max: number;
  maxHistoryBytes: number;
  effectiveMaxChars: number;
  offset: number | undefined;
  messageId: string | undefined;
  ignoreCliSessionImports?: boolean;
}): Promise<ChatHistoryPage> {
  const {
    entry,
    provider,
    sessionId,
    storePath,
    sessionAgentId,
    canonicalKey,
    max,
    maxHistoryBytes,
    effectiveMaxChars,
    offset,
    messageId,
  } = params;
  if (!sessionId || !storePath) {
    if (messageId) {
      return { messages: [] };
    }
    return {
      ...((offset ?? 0) === 0 ? { activeLeafEntryId: null } : {}),
      messages: [],
      ...(offset !== undefined ? { responseOffset: offset } : {}),
      pagination: { offset: offset ?? 0, totalMessages: 0, rawPageMessages: 0 },
    };
  }

  const readScope = {
    agentId: sessionAgentId,
    sessionEntry: entry,
    sessionId,
    sessionKey: canonicalKey,
    storePath,
  };
  const cliSessionId = params.ignoreCliSessionImports
    ? undefined
    : resolveClaudeCliBindingSessionId(entry);
  // Bound snapshots are terminal by contract, so offset requests return the same
  // full snapshot. Paging oversized imports needs an opaque snapshot cursor and
  // is deferred to a follow-up issue. Anchored reads fall through with them: the
  // full-snapshot merge below still centers on messageId at the handler cap.
  if ((offset !== undefined || messageId) && !cliSessionId) {
    let pageOffset = offset ?? 0;
    let hasOverreadContext = false;
    let readPage: ReadRecentSessionMessagesResult;
    let incrementalTail: IncrementalChatHistoryTail | undefined;
    if (messageId) {
      const anchoredPage = await readSessionMessagesAroundIdWithStatsAsync(readScope, {
        messageId,
        maxMessages: max,
        allowResetArchiveFallback: true,
      });
      if (!anchoredPage.found) {
        return { messages: [] };
      }
      pageOffset = anchoredPage.offset;
      hasOverreadContext = anchoredPage.hasOverreadContext;
      readPage = anchoredPage;
    } else {
      incrementalTail = await readIncrementalChatHistoryTail({
        entry,
        readScope,
        effectiveMaxChars,
        max,
        maxBytes: maxHistoryBytes,
        offset: pageOffset,
      });
      readPage = incrementalTail.readPage;
    }
    const isTailPage = !messageId && pageOffset === 0;
    const overreadContextMessage = incrementalTail
      ? incrementalTail.overreadContextMessage
      : hasOverreadContext || readPage.messages.length > max
        ? readPage.messages[0]
        : undefined;
    const localMessages = incrementalTail
      ? incrementalTail.rawMessages
      : dropChatHistoryOverreadContextMessage(
          dropPreSessionStartAnnouncePairs(
            readPage.messages,
            typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
          ),
          overreadContextMessage,
        );
    const rawPageMessages = incrementalTail
      ? incrementalTail.rawPageMessages
      : Math.min(
          max,
          Math.max(readPage.messages.length, readPage.totalMessages > pageOffset ? 1 : 0),
        );
    const project = (messages: unknown[]) =>
      projectChatDisplayMessagesWithState(messages, {
        includeCommentaryFallbacks: true,
        maxChars: effectiveMaxChars,
        resolveCurrentUserProfileDisplay,
        turnBoundaryPending: isHeartbeatHistoryTurnBoundaryMessage(overreadContextMessage),
      });
    const projection = incrementalTail?.projection ?? project(localMessages);
    let projected = incrementalTail?.projected ?? projection.messages;
    const newestPageSeq = readChatHistoryMessageSeq(localMessages.at(-1));
    if (
      !incrementalTail &&
      pageOffset > 0 &&
      newestPageSeq !== undefined &&
      projection.assistantErrorPending
    ) {
      const recoveryContext = await readChatHistoryRecoveryContext({
        messages: localMessages,
        project,
        readScope,
        displaySource: readPage.displaySource,
        maxBytes: maxHistoryBytes,
      });
      if (recoveryContext.length > 0) {
        projected = project([...localMessages, ...recoveryContext]).messages.filter(
          (message) => (readChatHistoryMessageSeq(message) ?? Infinity) <= newestPageSeq,
        );
      }
    }
    const windowed = messageId
      ? capChatHistoryAroundMessage({
          messages: projected,
          messageId,
          maxCost: max,
        })
      : projected;
    if (messageId) {
      // Numeric offsets do not encode the selected historical transcript source.
      return { messages: augmentChatHistoryWithCanvasBlocks(windowed) };
    }
    return {
      ...(isTailPage
        ? {
            activeLeafEntryId: resolveChatHistoryActiveLeafEntryId(readPage),
            ...(readPage.transcriptSource === "active" &&
            readPage.deltaCursor &&
            !incrementalTail?.projection.assistantErrorPending
              ? { deltaCursor: readPage.deltaCursor }
              : {}),
          }
        : {}),
      messages: augmentChatHistoryWithCanvasBlocks(windowed),
      responseOffset: pageOffset,
      pagination: {
        offset: pageOffset,
        totalMessages: readPage.totalMessages,
        rawPageMessages,
      },
    };
  }

  const incrementalTail = await readIncrementalChatHistoryTail({
    entry,
    readScope,
    effectiveMaxChars,
    max,
    maxBytes: maxHistoryBytes,
  });
  const { readPage } = incrementalTail;
  const activeLeafEntryId = resolveChatHistoryActiveLeafEntryId(readPage);
  const localMessagesWithBoundaryFilter = incrementalTail.rawMessages;
  // The ignore flag must gate this resolver too: the tail-window merge can report
  // imported=true while the full merge below dedupes everything to imported=false,
  // and an ungated re-resolve here would recurse through this branch forever.
  const importedMessages = params.ignoreCliSessionImports
    ? []
    : await readChatHistoryCliSessionImportSnapshot({
        entry,
        provider,
        localMessages: localMessagesWithBoundaryFilter,
      });
  const cliHistory = params.ignoreCliSessionImports
    ? { messages: localMessagesWithBoundaryFilter, imported: false }
    : resolveChatHistoryWithCliSessionImports({
        entry,
        provider,
        localMessages: localMessagesWithBoundaryFilter,
        preparedImportedMessages: importedMessages,
      });
  if ((offset !== undefined || messageId) && !cliHistory.imported) {
    return readChatHistoryPage({ ...params, ignoreCliSessionImports: true });
  }
  if (cliHistory.imported) {
    // Reuse this request's redacted external snapshot after the full local read;
    // re-reading here would duplicate a large import and defeat cross-client singleflight.
    const completeLocalMessages = dropPreSessionStartAnnouncePairs(
      await readSessionMessagesAsync(readScope, {
        mode: "full",
        reason: "chat.history CLI import merge",
        allowResetArchiveFallback: true,
      }),
      typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
    );
    const completeCliHistory = resolveChatHistoryWithCliSessionImports({
      entry,
      provider,
      localMessages: completeLocalMessages,
      preparedImportedMessages: importedMessages,
    });
    if (!completeCliHistory.imported) {
      return readChatHistoryPage({ ...params, ignoreCliSessionImports: true });
    }
    const mergedMessages = dropPreSessionStartAnnouncePairs(
      completeCliHistory.messages,
      typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
    );
    const displayMessages = projectChatDisplayMessages(mergedMessages, {
      includeCommentaryFallbacks: true,
      maxChars: effectiveMaxChars,
      resolveCurrentUserProfileDisplay,
    });
    // Import snapshots are terminal, but a missing display anchor is not a tail request.
    if (
      messageId &&
      !displayMessages.some((message) => readChatHistoryMessageId(message) === messageId)
    ) {
      return { messages: [] };
    }
    return {
      activeLeafEntryId,
      messages: augmentChatHistoryWithCanvasBlocks(displayMessages),
      completeCliImport: true,
      pagination: {
        offset: 0,
        totalMessages: mergedMessages.length,
        rawPageMessages: mergedMessages.length,
        exhausted: true,
      },
    };
  }
  return {
    activeLeafEntryId,
    ...(readPage.transcriptSource === "active" &&
    readPage.deltaCursor &&
    !incrementalTail.projection.assistantErrorPending
      ? { deltaCursor: readPage.deltaCursor }
      : {}),
    messages: augmentChatHistoryWithCanvasBlocks(incrementalTail.projected),
    pagination: {
      offset: 0,
      totalMessages: readPage.totalMessages,
      rawPageMessages: incrementalTail.rawPageMessages,
    },
  };
}
