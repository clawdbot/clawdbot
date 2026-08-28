// Gateway session-history projection state.
// Tracks transcript sequence windows for paginated chat-history SSE updates.
import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import type { SessionEntry } from "../config/sessions.js";
import {
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  projectChatDisplayMessages,
  projectChatDisplayMessagesWithState,
} from "./chat-display-projection.js";
import { resolveCurrentUserProfileDisplay } from "./current-user-profile-display.js";
import { getMaxChatHistoryMessagesBytes } from "./server-constants.js";
import {
  readChatHistoryMessageSeq as resolveMessageSeq,
  readIncrementalChatHistoryTail,
} from "./session-history-tail.js";
import { resolveTranscriptPathForComparison } from "./session-transcript-path.js";
import {
  attachOpenClawTranscriptMeta,
  readSessionMessagesPageWithStatsAsync,
  readSessionMessagesWithSourceAsync,
} from "./session-transcript-readers.js";

// Session history state owns the SSE-friendly projection of transcript JSONL:
// raw messages are projected for display, paginated by transcript seq, then
// incrementally updated until cursor/window semantics require a full refresh.
type SessionHistoryTranscriptMeta = {
  idempotencyKey?: string;
  seq?: number;
  turnBoundary?: boolean;
};

type SessionHistoryMessage = Record<string, unknown> & {
  __openclaw?: SessionHistoryTranscriptMeta;
};

type PaginatedSessionHistory = {
  items: SessionHistoryMessage[];
  messages: SessionHistoryMessage[];
  nextCursor?: string;
  hasMore: boolean;
};

type SessionHistorySnapshot = {
  history: PaginatedSessionHistory;
  rawTranscriptSeq: number;
  turnBoundaryPending: boolean;
  streamErrorFallbackPending: boolean;
};

type InlineSessionHistoryAppend = {
  message?: SessionHistoryMessage;
  messageSeq?: number;
  shouldRefresh?: boolean;
};

type SessionHistoryTranscriptTarget = {
  agentId?: string;
  sessionEntry?: SessionEntry;
  sessionId: string;
  sessionKey: string;
  storePath?: string;
};

type SessionHistoryRawSnapshot = {
  projection?: ReturnType<typeof projectChatDisplayMessagesWithState>;
  rawMessages: unknown[];
  rawTranscriptSeq?: number;
  totalRawMessages?: number;
  transcriptPath?: string;
};

type SessionHistoryStateSnapshot = SessionHistoryRawSnapshot & {
  target: SessionHistoryTranscriptTarget;
  maxChars?: number;
  limit?: number;
  cursor?: string;
};

function readMessageIdempotencyKey(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const value = (message as Record<string, unknown>).idempotencyKey;
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Owns both complete history snapshots and bounded visible-message pages. */
export async function readSessionHistoryRawSnapshotAsync(
  params: Pick<SessionHistoryStateSnapshot, "target" | "maxChars" | "limit" | "cursor">,
): Promise<SessionHistoryRawSnapshot> {
  if (typeof params.limit !== "number") {
    const snapshot = await readSessionMessagesWithSourceAsync(params.target, {
      mode: "full",
      reason: "session history cursor pagination",
      allowResetArchiveFallback: true,
    });
    return { rawMessages: snapshot.messages, transcriptPath: snapshot.transcriptPath };
  }
  const cursorSeq = resolveCursorSeq(params.cursor);
  const offset =
    cursorSeq === undefined
      ? undefined
      : Math.max(
          0,
          (
            await readSessionMessagesPageWithStatsAsync(params.target, {
              offset: 0,
              maxMessages: 0,
              allowResetArchiveFallback: true,
            })
          ).totalMessages -
            cursorSeq +
            1,
        );
  const tail = await readIncrementalChatHistoryTail({
    entry: params.target.sessionEntry,
    readScope: params.target,
    effectiveMaxChars: params.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
    max: params.limit,
    maxBytes: getMaxChatHistoryMessagesBytes(),
    ...(offset === undefined ? {} : { offset }),
    preserveProjectionContext: true,
  });
  return {
    projection: tail.projection,
    rawMessages: tail.rawMessages,
    rawTranscriptSeq: tail.readPage.totalMessages,
    totalRawMessages: tail.readPage.totalMessages,
    transcriptPath: tail.readPage.transcriptPath,
  };
}

export function resolveCursorSeq(cursor: string | undefined): number | undefined {
  if (!cursor) {
    return undefined;
  }
  const normalized = cursor.startsWith("seq:") ? cursor.slice(4) : cursor;
  if (!/^\d+$/.test(normalized)) {
    return undefined;
  }
  const value = Number(normalized);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function toSessionHistoryMessages(messages: unknown[]): SessionHistoryMessage[] {
  return messages.filter(
    (message): message is SessionHistoryMessage =>
      Boolean(message) && typeof message === "object" && !Array.isArray(message),
  );
}

function buildPaginatedSessionHistory(params: {
  messages: SessionHistoryMessage[];
  hasMore: boolean;
  nextCursor?: string;
}): PaginatedSessionHistory {
  return {
    items: params.messages,
    messages: params.messages,
    hasMore: params.hasMore,
    ...(params.nextCursor ? { nextCursor: params.nextCursor } : {}),
  };
}

function isMessageToolMirrorMessage(message: SessionHistoryMessage): boolean {
  return message.openclawMessageToolMirror !== undefined;
}

function paginateSessionMessages(
  messages: SessionHistoryMessage[],
  limit: number | undefined,
  cursor: string | undefined,
): PaginatedSessionHistory {
  // Cursors point at transcript sequence watermarks. The returned page is the
  // window before that cursor, matching "older messages" pagination.
  const cursorSeq = resolveCursorSeq(cursor);
  let endExclusive = messages.length;
  if (typeof cursorSeq === "number") {
    endExclusive = messages.findIndex((message, index) => {
      const seq = resolveMessageSeq(message);
      if (typeof seq === "number") {
        return seq >= cursorSeq;
      }
      return index + 1 >= cursorSeq;
    });
    if (endExclusive < 0) {
      endExclusive = messages.length;
    }
  }
  let start = typeof limit === "number" && limit > 0 ? Math.max(0, endExclusive - limit) : 0;
  // Projection can interleave several rows from the same transcript records.
  // Close the page over their seq groups because the public cursor cannot split one.
  const pageSeqs = new Set(
    messages.slice(start, endExclusive).map(resolveMessageSeq).filter(Boolean),
  );
  const gapSeqs = new Set<number>();
  for (let index = start - 1; index >= 0; index--) {
    const seq = resolveMessageSeq(messages[index]);
    if (seq === undefined) {
      continue;
    }
    gapSeqs.add(seq);
    if (!pageSeqs.has(seq)) {
      continue;
    }
    start = index;
    gapSeqs.forEach((gapSeq) => pageSeqs.add(gapSeq));
    gapSeqs.clear();
  }
  const paginatedMessages = messages.slice(start, endExclusive);
  const firstSeq = resolveMessageSeq(paginatedMessages[0]);
  return buildPaginatedSessionHistory({
    messages: paginatedMessages,
    hasMore: start > 0,
    ...(start > 0 && typeof firstSeq === "number" ? { nextCursor: String(firstSeq) } : {}),
  });
}

/** Builds the display history snapshot and raw transcript sequence watermark. */
export function buildSessionHistorySnapshot(params: {
  projection?: ReturnType<typeof projectChatDisplayMessagesWithState>;
  rawMessages: unknown[];
  maxChars?: number;
  limit?: number;
  cursor?: string;
  rawTranscriptSeq?: number;
  totalRawMessages?: number;
}): SessionHistorySnapshot {
  const projected =
    params.projection ??
    projectChatDisplayMessagesWithState(params.rawMessages, {
      includeCommentaryFallbacks: true,
      maxChars: params.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
      redactInlineMedia: true,
      resolveCurrentUserProfileDisplay,
    });
  const visibleMessages = projected.messages;
  const rawHistoryMessages = toSessionHistoryMessages(params.rawMessages);
  const history = paginateSessionMessages(visibleMessages, params.limit, params.cursor);
  if (
    typeof params.totalRawMessages === "number" &&
    params.totalRawMessages > params.rawMessages.length &&
    (!params.cursor || (resolveMessageSeq(rawHistoryMessages[0]) ?? 0) > 1)
  ) {
    const firstSeq = resolveMessageSeq(history.messages[0] ?? rawHistoryMessages[0]);
    history.hasMore = true;
    if (typeof firstSeq === "number") {
      history.nextCursor = String(firstSeq);
    }
  }
  return {
    history,
    rawTranscriptSeq:
      params.rawTranscriptSeq ??
      resolveMessageSeq(rawHistoryMessages.at(-1)) ??
      rawHistoryMessages.length,
    turnBoundaryPending: projected.turnBoundaryPending,
    streamErrorFallbackPending: projected.streamErrorFallbackPending,
  };
}

/** Tracks session-history SSE state and decides when inline appends are still valid. */
export class SessionHistorySseState {
  private readonly target: SessionHistoryTranscriptTarget;
  private readonly maxChars: number;
  private readonly limit: number | undefined;
  private readonly cursor: string | undefined;
  private sentHistory: PaginatedSessionHistory;
  private rawTranscriptSeq: number;
  private turnBoundaryPending: boolean;
  private streamErrorFallbackPending: boolean;
  private transcriptPath: string | undefined;

  static fromRawSnapshot(params: SessionHistoryStateSnapshot): SessionHistorySseState {
    return new SessionHistorySseState(params);
  }

  private constructor(params: SessionHistoryStateSnapshot) {
    this.target = params.target;
    this.maxChars = params.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS;
    this.limit = params.limit;
    this.cursor = params.cursor;
    const snapshot = this.buildSnapshot(params);
    this.sentHistory = snapshot.history;
    this.rawTranscriptSeq = snapshot.rawTranscriptSeq;
    this.turnBoundaryPending = snapshot.turnBoundaryPending;
    this.streamErrorFallbackPending = snapshot.streamErrorFallbackPending;
    this.transcriptPath = normalizeTranscriptPathForComparison(params.transcriptPath);
  }

  snapshot(): PaginatedSessionHistory {
    return this.sentHistory;
  }

  retainRecentMessages(maxMessages: number): PaginatedSessionHistory {
    if (this.sentHistory.messages.length <= maxMessages) {
      return this.snapshot();
    }

    const messages = this.sentHistory.messages.slice(-maxMessages);
    const firstSeq = resolveMessageSeq(messages[0]);
    this.sentHistory = buildPaginatedSessionHistory({
      messages,
      hasMore: true,
      ...(firstSeq !== undefined ? { nextCursor: String(firstSeq) } : {}),
    });
    return this.snapshot();
  }

  appendInlineMessage(update: {
    message: unknown;
    messageId?: string;
    messageSeq?: number;
  }): InlineSessionHistoryAppend | null {
    if (this.limit !== undefined || this.cursor !== undefined) {
      return null;
    }
    const carriedSeq = asPositiveSafeInteger(update.messageSeq);
    if (carriedSeq !== undefined) {
      if (carriedSeq <= this.rawTranscriptSeq) {
        return { shouldRefresh: true };
      }
      this.rawTranscriptSeq = carriedSeq;
    } else {
      this.rawTranscriptSeq += 1;
    }
    const idempotencyKey = readMessageIdempotencyKey(update.message);
    const nextMessage = attachOpenClawTranscriptMeta(update.message, {
      ...(typeof update.messageId === "string" ? { id: update.messageId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      seq: this.rawTranscriptSeq,
    });
    const hadPendingTurnBoundary = this.turnBoundaryPending;
    const nextProjection = projectChatDisplayMessagesWithState([nextMessage], {
      includeCommentaryFallbacks: true,
      maxChars: this.maxChars,
      redactInlineMedia: true,
      turnBoundaryPending: hadPendingTurnBoundary,
      streamErrorFallbackPending: this.streamErrorFallbackPending,
    });
    this.turnBoundaryPending = nextProjection.turnBoundaryPending;
    this.streamErrorFallbackPending = nextProjection.streamErrorFallbackPending;
    if (nextProjection.streamErrorFallbackRepaired) {
      // Keep only the pending bit here: retaining raw transcript context would
      // undo the bounded SSE memory contract. The caller rereads canonical
      // history so full projection can remove the already-emitted placeholder.
      return { shouldRefresh: true };
    }
    // Projection can split, drop, or rewrite raw transcript messages. When one
    // raw append changes multiple visible rows, callers must refresh instead of
    // emitting a misleading single SSE item.
    const projectedMessages = projectChatDisplayMessages(
      [...this.sentHistory.messages, nextMessage],
      {
        includeCommentaryFallbacks: true,
        maxChars: this.maxChars,
        redactInlineMedia: true,
        resolveCurrentUserProfileDisplay,
      },
    );
    const projectedPrefix = projectedMessages.slice(0, this.sentHistory.messages.length);
    if (
      projectedMessages.length > this.sentHistory.messages.length &&
      !isDeepStrictEqual(projectedPrefix, this.sentHistory.messages)
    ) {
      // A current-profile change can rewrite an already-emitted row while this
      // append adds only one tail item. Refresh the full history so the client
      // does not retain a stale prefix beside the newly revisioned message.
      this.sentHistory = buildPaginatedSessionHistory({
        messages: projectedMessages,
        hasMore: false,
      });
      return { shouldRefresh: true };
    }
    if (projectedMessages.length > this.sentHistory.messages.length) {
      const addedMessages = projectedMessages.slice(this.sentHistory.messages.length);
      if (hadPendingTurnBoundary && !this.turnBoundaryPending) {
        const firstAdded = attachOpenClawTranscriptMeta(addedMessages[0], {
          turnBoundary: true,
        }) as SessionHistoryMessage;
        addedMessages[0] = firstAdded;
        projectedMessages[this.sentHistory.messages.length] = firstAdded;
      }
      if (addedMessages.length > 1) {
        this.sentHistory = buildPaginatedSessionHistory({
          messages: projectedMessages,
          hasMore: false,
        });
        return { shouldRefresh: true };
      }
      const projectedMessage = expectDefined(addedMessages[0], "projected inline message");
      const emittedMessage: SessionHistoryMessage =
        isMessageToolMirrorMessage(projectedMessage) ||
        resolveMessageSeq(projectedMessage) === undefined
          ? (attachOpenClawTranscriptMeta(projectedMessage, {
              seq: this.rawTranscriptSeq,
            }) as SessionHistoryMessage)
          : projectedMessage;
      this.sentHistory = buildPaginatedSessionHistory({
        messages: [...this.sentHistory.messages, emittedMessage],
        hasMore: false,
      });
      return { message: emittedMessage, messageSeq: resolveMessageSeq(emittedMessage) };
    }
    if (
      nextProjection.messages.length === 0 &&
      projectedMessages.length === this.sentHistory.messages.length
    ) {
      return null;
    }
    this.sentHistory = buildPaginatedSessionHistory({
      messages: projectedMessages,
      hasMore: false,
    });
    return { shouldRefresh: true };
  }

  shouldRefreshForTranscriptPath(updatePath: string | undefined): boolean {
    const nextPath = normalizeTranscriptPathForComparison(updatePath);
    return Boolean(this.transcriptPath && nextPath && this.transcriptPath !== nextPath);
  }

  async refreshAsync(): Promise<PaginatedSessionHistory> {
    const rawSnapshot = await readSessionHistoryRawSnapshotAsync({
      target: this.target,
      maxChars: this.maxChars,
      limit: this.limit,
      cursor: this.cursor,
    });
    const snapshot = this.buildSnapshot(rawSnapshot);
    this.rawTranscriptSeq = snapshot.rawTranscriptSeq;
    this.turnBoundaryPending = snapshot.turnBoundaryPending;
    this.streamErrorFallbackPending = snapshot.streamErrorFallbackPending;
    this.transcriptPath = normalizeTranscriptPathForComparison(rawSnapshot.transcriptPath);
    this.sentHistory = snapshot.history;
    return snapshot.history;
  }

  private buildSnapshot(rawSnapshot: SessionHistoryRawSnapshot): SessionHistorySnapshot {
    return buildSessionHistorySnapshot({
      projection: rawSnapshot.projection,
      rawMessages: rawSnapshot.rawMessages,
      maxChars: this.maxChars,
      limit: this.limit,
      cursor: this.cursor,
      rawTranscriptSeq: rawSnapshot.rawTranscriptSeq,
      totalRawMessages: rawSnapshot.totalRawMessages,
    });
  }
}

function normalizeTranscriptPathForComparison(filePath: string | undefined): string | undefined {
  return typeof filePath === "string" ? resolveTranscriptPathForComparison(filePath) : undefined;
}
