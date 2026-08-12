import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveSessionTranscriptActiveLeafEntryId } from "../../config/sessions/session-accessor.js";
import {
  dropPreSessionStartAnnouncePairs,
  isHeartbeatHistoryTurnBoundaryMessage,
  projectChatDisplayMessages,
  projectRecentChatDisplayMessages,
} from "../chat-display-projection.js";
import { augmentChatHistoryWithCanvasBlocks } from "../chat-display-projection.js";
import {
  resolveChatHistoryWithCliSessionImports,
  resolveClaudeCliBindingSessionId,
} from "../cli-session-history.js";
import { resolveCurrentUserProfileDisplay } from "../current-user-profile-display.js";
import { resolveSessionHistoryTailReadOptions } from "../session-history-state.js";
import { readSessionMessagesAroundIdWithStatsAsync } from "../session-transcript-anchor-reader.js";
import {
  readRecentSessionMessagesWithStatsAsync,
  readSessionMessagesAsync,
  readSessionMessagesPageWithStatsAsync,
  type ReadRecentSessionMessagesResult,
  type SessionTranscriptReadScope,
} from "../session-transcript-readers.js";
import type { loadSessionEntry } from "../session-utils.js";

export function readChatHistoryMessageId(message: unknown): string | undefined {
  const metadata = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
  return typeof metadata?.id === "string" ? metadata.id : undefined;
}

export function readChatHistoryMessageSeq(message: unknown): number | undefined {
  const metadata = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
  return asPositiveSafeInteger(metadata?.seq);
}

type ChatHistoryPage = {
  activeLeafEntryId?: string | null;
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

// A silent tail can outrun the bounded raw window: tool traffic, hidden
// memory-flush prompts, and dropped silent turns all consume raw records
// without producing a display row, so the newest window can project to nothing
// while visible history is still on the branch. Snapshot clients rebuild
// destructively from a first page, so returning that empty page erases a
// rendered conversation the transcript still holds. Scan older pages until a
// display row appears, bounded so a pathological transcript cannot turn the
// tail read into a full scan.
const SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_MESSAGES = 8_000;
// Chunk size stays independent of the requested display limit: a `limit: 1`
// request must not turn the scan into one transcript read per raw record. Pages
// are contiguous and released between iterations, and the chunk stays below the
// record count an explicit offset page already materializes, so peak scan memory
// never exceeds what one ordinary history page costs. A byte-budgeted read is
// deliberately not used here: it drops oversized records from the middle of a
// window, which would punch holes in the cursor and hide the oversized-message
// placeholder the handler would otherwise render. Accepted tradeoff: a chunk is
// materialized before its bytes can be counted, so the walk can overshoot its
// budget by one page. That page is smaller than the one every explicit offset
// request already reads, and closing the gap would need a stop-at-budget
// contiguous reader that does not exist yet.
const SILENT_CHAT_HISTORY_TAIL_SCAN_CHUNK_MESSAGES = 100;

/** Keeps a first history page displayable by scanning past an all-silent raw tail. */
async function resolveDisplayableChatHistoryTail(params: {
  entry: ReturnType<typeof loadSessionEntry>["entry"];
  readScope: SessionTranscriptReadScope;
  effectiveMaxChars: number;
  max: number;
  maxBytes: number;
  projected: unknown[];
  rawMessages: unknown[];
  rawPageMessages: number;
  totalMessages: number;
}): Promise<{ messages: unknown[]; rawPageMessages: number }> {
  const unchanged = { messages: params.projected, rawPageMessages: params.rawPageMessages };
  if (params.projected.length > 0 || params.totalMessages <= params.rawPageMessages) {
    return unchanged;
  }
  const sessionStartedAt =
    typeof params.entry?.sessionStartedAt === "number" ? params.entry.sessionStartedAt : undefined;
  const scanLimit = params.rawPageMessages + SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_MESSAGES;
  let scanned = params.rawPageMessages;
  // Record count alone does not bound a walk over large tool results, and the
  // reader cannot bound it either: a byte-budgeted page skips an oversized
  // record mid-window, which would strand it and its placeholder. Budget the
  // whole walk instead, at the payload one history response may already return.
  let scannedBytes = 0;
  // Projection pairs records across turns (message-tool sends and their
  // results, turn boundaries), so each chunk is projected together with the
  // already-read newer records it borders. Only the neighbour is carried, which
  // keeps the working set at two chunks plus the tail window.
  let newerRawMessages = params.rawMessages;
  while (scanned < params.totalMessages && scanned < scanLimit) {
    const page = await readSessionMessagesPageWithStatsAsync(params.readScope, {
      offset: scanned,
      maxMessages: SILENT_CHAT_HISTORY_TAIL_SCAN_CHUNK_MESSAGES + 1,
      allowResetArchiveFallback: true,
    });
    if (page.messages.length === 0) {
      return unchanged;
    }
    // The extra oldest record only supplies pair-filter and turn-boundary
    // context. Without it a chunk boundary between a stale announce and its
    // reply would leak the reply that the tail read hides. Each chunk's context
    // record is the newest record of the next chunk, so this one overread also
    // covers every junction the walk creates, including tail-to-first-chunk.
    const contextMessage =
      page.messages.length > SILENT_CHAT_HISTORY_TAIL_SCAN_CHUNK_MESSAGES
        ? page.messages[0]
        : undefined;
    scanned += page.messages.length - (contextMessage === undefined ? 0 : 1);
    const chunkMessages = dropLocalHistoryOverreadContextMessage(
      dropPreSessionStartAnnouncePairs(page.messages, sessionStartedAt),
      contextMessage,
    );
    const projected = projectRecentChatDisplayMessages([...chunkMessages, ...newerRawMessages], {
      maxChars: params.effectiveMaxChars,
      maxMessages: params.max,
      resolveCurrentUserProfileDisplay,
      turnBoundaryPending: isHeartbeatHistoryTurnBoundaryMessage(contextMessage),
    });
    if (projected.length > 0) {
      return { messages: projected, rawPageMessages: scanned };
    }
    scannedBytes += Buffer.byteLength(JSON.stringify(page.messages), "utf8");
    if (scannedBytes >= params.maxBytes) {
      return unchanged;
    }
    newerRawMessages = chunkMessages;
  }
  return unchanged;
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
    const rawHistoryWindow = resolveSessionHistoryTailReadOptions(max);
    let pageOffset = offset ?? 0;
    let hasOverreadContext = false;
    let readPage: ReadRecentSessionMessagesResult;
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
          resolveCurrentUserProfileDisplay,
          turnBoundaryPending: isHeartbeatHistoryTurnBoundaryMessage(overreadContextMessage),
        })
      : projectChatDisplayMessages(recencyFilteredMessages, {
          maxChars: effectiveMaxChars,
          resolveCurrentUserProfileDisplay,
          turnBoundaryPending: isHeartbeatHistoryTurnBoundaryMessage(overreadContextMessage),
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
    if (messageId) {
      // Numeric offsets do not encode the selected historical transcript source.
      return { messages: augmentChatHistoryWithCanvasBlocks(windowed) };
    }
    const tail = isTailPage
      ? await resolveDisplayableChatHistoryTail({
          entry,
          readScope,
          effectiveMaxChars,
          max,
          maxBytes: maxHistoryBytes,
          projected: windowed,
          rawMessages: recencyFilteredMessages,
          rawPageMessages,
          totalMessages: readPage.totalMessages,
        })
      : { messages: windowed, rawPageMessages };
    return {
      ...(isTailPage
        ? {
            activeLeafEntryId: resolveChatHistoryActiveLeafEntryId(readPage),
          }
        : {}),
      messages: augmentChatHistoryWithCanvasBlocks(tail.messages),
      responseOffset: pageOffset,
      pagination: {
        offset: pageOffset,
        totalMessages: readPage.totalMessages,
        rawPageMessages: tail.rawPageMessages,
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
  const turnBoundaryPending = isHeartbeatHistoryTurnBoundaryMessage(overreadContextMessage);
  const activeLeafEntryId = resolveChatHistoryActiveLeafEntryId(readPage);
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
      resolveCurrentUserProfileDisplay,
    });
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
    resolveCurrentUserProfileDisplay,
    turnBoundaryPending,
  });
  const tail = await resolveDisplayableChatHistoryTail({
    entry,
    readScope,
    effectiveMaxChars,
    max,
    maxBytes: maxHistoryBytes,
    projected: displayMessages,
    rawMessages: recencyFilteredMessages,
    // The extra record supplies pair-filter context; it was not returned and
    // must remain reachable by the next strictly-older page.
    rawPageMessages: Math.min(
      rawHistoryWindow.maxMessages,
      Math.max(readPage.messages.length, readPage.totalMessages > 0 ? 1 : 0),
    ),
    totalMessages: readPage.totalMessages,
  });
  return {
    activeLeafEntryId,
    messages: augmentChatHistoryWithCanvasBlocks(tail.messages),
    pagination: {
      offset: 0,
      totalMessages: readPage.totalMessages,
      rawPageMessages: tail.rawPageMessages,
    },
  };
}
