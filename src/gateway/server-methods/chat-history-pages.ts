import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  dropPreSessionStartAnnouncePairs,
  projectChatDisplayMessages,
  projectRecentChatDisplayMessages,
} from "../chat-display-projection.js";
import { augmentChatHistoryWithCanvasBlocks } from "../chat-display-projection.js";
import {
  resolveChatHistoryWithCliSessionImports,
  resolveClaudeCliBindingSessionId,
} from "../cli-session-history.js";
import { resolveSessionHistoryTailReadOptions } from "../session-history-state.js";
import { readSessionMessagesAroundIdWithStatsAsync } from "../session-transcript-anchor-reader.js";
import {
  readRecentSessionMessagesWithStatsAsync,
  readSessionMessagesAsync,
  readSessionMessagesPageWithStatsAsync,
} from "../session-transcript-readers.js";
import type { loadSessionEntry } from "../session-utils.js";

export function readChatHistoryMessageId(message: unknown): string | undefined {
  const metadata = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
  return typeof metadata?.id === "string" ? metadata.id : undefined;
}

export function readChatHistoryMessageSeq(message: unknown): number | undefined {
  const metadata = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
  const seq = metadata?.seq;
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0 ? seq : undefined;
}

type ChatHistoryPage = {
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

function capOffsetChatHistoryProjectedMessages(messages: unknown[], max: number): unknown[] {
  if (messages.length <= max) {
    return messages;
  }
  const start = Math.max(0, messages.length - max);
  const boundarySeq = readChatHistoryMessageSeq(messages[start]);
  if (boundarySeq === undefined) {
    return messages.slice(start);
  }
  // Offset cursors can only resume at transcript-record boundaries.
  // Keep boundary rows with the same seq together so projection mirrors are not stranded.
  let safeStart = start;
  while (safeStart > 0 && readChatHistoryMessageSeq(messages[safeStart - 1]) === boundarySeq) {
    safeStart--;
  }
  return messages.slice(safeStart);
}

function resolveChatHistoryMessageGroup(
  messages: unknown[],
  index: number,
): { start: number; end: number } {
  const seq = readChatHistoryMessageSeq(messages[index]);
  if (seq === undefined) {
    return { start: index, end: index + 1 };
  }
  let start = index;
  let end = index + 1;
  while (start > 0 && readChatHistoryMessageSeq(messages[start - 1]) === seq) {
    start -= 1;
  }
  while (end < messages.length && readChatHistoryMessageSeq(messages[end]) === seq) {
    end += 1;
  }
  return { start, end };
}

export function capChatHistoryAroundMessage(params: {
  messages: unknown[];
  messageId: string;
  fits: (messages: unknown[]) => boolean;
}): unknown[] | undefined {
  const anchorIndex = params.messages.findIndex(
    (message) => readChatHistoryMessageId(message) === params.messageId,
  );
  if (anchorIndex === -1) {
    return undefined;
  }
  const anchorGroup = resolveChatHistoryMessageGroup(params.messages, anchorIndex);
  if (!params.fits(params.messages.slice(anchorGroup.start, anchorGroup.end))) {
    return [params.messages[anchorIndex]];
  }

  let { start, end } = anchorGroup;
  let canGrowOlder = start > 0;
  let canGrowNewer = end < params.messages.length;
  while (canGrowOlder || canGrowNewer) {
    if (canGrowOlder) {
      const olderGroup = resolveChatHistoryMessageGroup(params.messages, start - 1);
      if (params.fits(params.messages.slice(olderGroup.start, end))) {
        start = olderGroup.start;
      } else {
        canGrowOlder = false;
      }
    }
    canGrowOlder &&= start > 0;

    if (canGrowNewer) {
      const newerGroup = resolveChatHistoryMessageGroup(params.messages, end);
      if (params.fits(params.messages.slice(start, newerGroup.end))) {
        end = newerGroup.end;
      } else {
        canGrowNewer = false;
      }
    }
    canGrowNewer &&= end < params.messages.length;
  }
  return params.messages.slice(start, end);
}

function dropLocalHistoryOverreadContextMessage(
  messages: unknown[],
  contextMessage: unknown,
): unknown[] {
  if (contextMessage === undefined) {
    return messages;
  }
  const index = messages.indexOf(contextMessage);
  if (index < 0) {
    return messages;
  }
  return [...messages.slice(0, index), ...messages.slice(index + 1)];
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
    const rawHistoryWindow = resolveSessionHistoryTailReadOptions(max);
    let pageOffset = offset ?? 0;
    let hasOverreadContext = false;
    let readPage: { messages: unknown[]; totalMessages: number };
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
    } else if (pageOffset === 0) {
      readPage = await readRecentSessionMessagesWithStatsAsync(readScope, {
        maxMessages: rawHistoryWindow.maxMessages + 1,
        maxLines: rawHistoryWindow.maxLines + 1,
        maxBytes: Math.max(maxHistoryBytes * 2, 1024 * 1024),
        allowResetArchiveFallback: true,
      });
    } else {
      readPage = await readSessionMessagesPageWithStatsAsync(readScope, {
        offset: pageOffset,
        maxMessages: max + 1,
        allowResetArchiveFallback: true,
      });
    }
    const isTailPage = !messageId && pageOffset === 0;
    const overreadContextMessage = isTailPage
      ? readPage.messages.length > rawHistoryWindow.maxMessages
        ? readPage.messages[0]
        : undefined
      : hasOverreadContext || readPage.messages.length > max
        ? readPage.messages[0]
        : undefined;
    const localMessages = dropLocalHistoryOverreadContextMessage(
      dropPreSessionStartAnnouncePairs(
        readPage.messages,
        typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
      ),
      overreadContextMessage,
    );
    const rawPageMessages = isTailPage
      ? Math.min(
          rawHistoryWindow.maxMessages,
          Math.max(readPage.messages.length, readPage.totalMessages > 0 ? 1 : 0),
        )
      : Math.min(
          max,
          Math.max(readPage.messages.length, readPage.totalMessages > pageOffset ? 1 : 0),
        );
    const rawMessages = localMessages;
    const recencyFilteredMessages = dropPreSessionStartAnnouncePairs(
      rawMessages,
      typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
    );
    const projected = isTailPage
      ? projectRecentChatDisplayMessages(recencyFilteredMessages, {
          maxChars: effectiveMaxChars,
          maxMessages: max,
        })
      : projectChatDisplayMessages(recencyFilteredMessages, {
          maxChars: effectiveMaxChars,
        });
    const windowed = messageId
      ? (capChatHistoryAroundMessage({
          messages: projected,
          messageId,
          fits: (messages) => messages.length <= max,
        }) ?? capOffsetChatHistoryProjectedMessages(projected, max))
      : isTailPage
        ? projected
        : capOffsetChatHistoryProjectedMessages(projected, max);
    const normalized = augmentChatHistoryWithCanvasBlocks(windowed);
    if (messageId) {
      // Numeric offsets do not encode the selected historical transcript source.
      return { messages: normalized };
    }
    return {
      messages: normalized,
      responseOffset: pageOffset,
      pagination: {
        offset: pageOffset,
        totalMessages: readPage.totalMessages,
        rawPageMessages,
      },
    };
  }

  const rawHistoryWindow = resolveSessionHistoryTailReadOptions(max);
  const localHistoryReadOptions = {
    maxMessages: rawHistoryWindow.maxMessages + 1,
    maxLines: rawHistoryWindow.maxLines + 1,
  };
  const readPage = await readRecentSessionMessagesWithStatsAsync(readScope, {
    ...localHistoryReadOptions,
    maxBytes: Math.max(maxHistoryBytes * 2, 1024 * 1024),
    allowResetArchiveFallback: true,
  });
  const overreadContextMessage =
    readPage.messages.length > rawHistoryWindow.maxMessages ? readPage.messages[0] : undefined;
  const localMessagesWithBoundaryFilter = dropLocalHistoryOverreadContextMessage(
    dropPreSessionStartAnnouncePairs(
      readPage.messages,
      typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
    ),
    overreadContextMessage,
  );
  // The ignore flag must gate this resolver too: the tail-window merge can report
  // imported=true while the full merge below dedupes everything to imported=false,
  // and an ungated re-resolve here would recurse through this branch forever.
  const cliHistory = params.ignoreCliSessionImports
    ? { messages: localMessagesWithBoundaryFilter, imported: false as const }
    : resolveChatHistoryWithCliSessionImports({
        entry,
        provider,
        localMessages: localMessagesWithBoundaryFilter,
      });
  if ((offset !== undefined || messageId) && !cliHistory.imported) {
    return readChatHistoryPage({ ...params, ignoreCliSessionImports: true });
  }
  if (cliHistory.imported) {
    // The import reader already scans the complete external JSONL. Only after it
    // succeeds do the matching full local read needed to build a pageable merge.
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
    });
    if (!completeCliHistory.imported) {
      return readChatHistoryPage({ ...params, ignoreCliSessionImports: true });
    }
    const mergedMessages = dropPreSessionStartAnnouncePairs(
      completeCliHistory.messages,
      typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
    );
    const displayMessages = projectChatDisplayMessages(mergedMessages, {
      maxChars: effectiveMaxChars,
    });
    return {
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
  const rawMessages = cliHistory.messages;
  // Drop subagent_announce pairs (user inter-session announce + adjacent
  // assistant) whose record timestamp predates the current session's
  // sessionStartedAt. Run after CLI history imports too, because those
  // timestamped messages share the same chat.history response surface.
  const recencyFilteredMessages = dropPreSessionStartAnnouncePairs(
    rawMessages,
    typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
  );
  const displayMessages = projectRecentChatDisplayMessages(recencyFilteredMessages, {
    maxChars: effectiveMaxChars,
    maxMessages: max,
  });
  return {
    messages: augmentChatHistoryWithCanvasBlocks(displayMessages),
    pagination: {
      offset: 0,
      totalMessages: readPage.totalMessages,
      // The extra record supplies pair-filter context; it was not returned and
      // must remain reachable by the next strictly-older page.
      rawPageMessages: Math.min(
        rawHistoryWindow.maxMessages,
        Math.max(readPage.messages.length, readPage.totalMessages > 0 ? 1 : 0),
      ),
    },
  };
}
