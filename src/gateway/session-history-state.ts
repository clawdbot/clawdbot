// Gateway session-history projection state.
// Tracks transcript sequence windows for paginated chat-history SSE updates.
import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import {
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  projectChatDisplayMessages,
  projectChatDisplayMessagesWithState,
} from "./chat-display-projection.js";
import { resolveTranscriptPathForComparison } from "./session-transcript-path.js";
import {
  attachOpenClawTranscriptMeta,
  readRecentSessionMessagesWithStatsAsync,
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
};

type InlineSessionHistoryAppend = {
  message?: SessionHistoryMessage;
  messageSeq?: number;
  shouldRefresh?: boolean;
};

type SessionHistoryTranscriptTarget = {
  agentId?: string;
  sessionEntry?: { sessionFile?: string; sessionId?: string };
  sessionId: string;
  sessionKey: string;
  storePath?: string;
};

type SessionHistoryRawSnapshot = {
  rawMessages: unknown[];
  rawTranscriptSeq?: number;
  totalRawMessages?: number;
  transcriptPath?: string;
};

function readMessageIdempotencyKey(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const value = (message as Record<string, unknown>).idempotencyKey;
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Computes an oversized raw transcript tail window for projected chat history. */
export function resolveSessionHistoryTailReadOptions(limit: number): {
  maxMessages: number;
  maxLines: number;
} {
  const requested = Math.max(1, Math.floor(limit));
  const rawWindow = requested * 20 + 20;
  return {
    maxMessages: rawWindow,
    maxLines: rawWindow,
  };
}

function resolveCursorSeq(cursor: string | undefined): number | undefined {
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

function resolveMessageSeq(message: SessionHistoryMessage | undefined): number | undefined {
  return asPositiveSafeInteger(message?.["__openclaw"]?.seq);
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
  const start = typeof limit === "number" && limit > 0 ? Math.max(0, endExclusive - limit) : 0;
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
  rawMessages: unknown[];
  maxChars?: number;
  limit?: number;
  cursor?: string;
  rawTranscriptSeq?: number;
  totalRawMessages?: number;
}): SessionHistorySnapshot {
  const projected = projectChatDisplayMessagesWithState(params.rawMessages, {
    maxChars: params.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  });
  const visibleMessages = toSessionHistoryMessages(projected.messages);
  const history = paginateSessionMessages(visibleMessages, params.limit, params.cursor);
  if (
    !params.cursor &&
    typeof params.totalRawMessages === "number" &&
    params.totalRawMessages > params.rawMessages.length &&
    history.messages.length > 0
  ) {
    const firstSeq = resolveMessageSeq(history.messages[0]);
    history.hasMore = true;
    if (typeof firstSeq === "number") {
      history.nextCursor = String(firstSeq);
    }
  }
  const rawHistoryMessages = toSessionHistoryMessages(params.rawMessages);
  return {
    history,
    rawTranscriptSeq:
      params.rawTranscriptSeq ??
      resolveMessageSeq(rawHistoryMessages.at(-1)) ??
      rawHistoryMessages.length,
    turnBoundaryPending: projected.turnBoundaryPending,
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
  private transcriptPath: string | undefined;

  static fromRawSnapshot(params: {
    target: SessionHistoryTranscriptTarget;
    rawMessages: unknown[];
    rawTranscriptSeq?: number;
    totalRawMessages?: number;
    transcriptPath?: string;
    maxChars?: number;
    limit?: number;
    cursor?: string;
  }): SessionHistorySseState {
    return new SessionHistorySseState({
      target: params.target,
      maxChars: params.maxChars,
      limit: params.limit,
      cursor: params.cursor,
      initialRawMessages: params.rawMessages,
      rawTranscriptSeq: params.rawTranscriptSeq,
      totalRawMessages: params.totalRawMessages,
      transcriptPath: params.transcriptPath,
    });
  }

  private constructor(params: {
    target: SessionHistoryTranscriptTarget;
    maxChars?: number;
    limit?: number;
    cursor?: string;
    initialRawMessages: unknown[];
    rawTranscriptSeq?: number;
    totalRawMessages?: number;
    transcriptPath?: string;
  }) {
    this.target = params.target;
    this.maxChars = params.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS;
    this.limit = params.limit;
    this.cursor = params.cursor;
    const snapshot = this.buildSnapshot({
      rawMessages: params.initialRawMessages,
      ...(typeof params.rawTranscriptSeq === "number"
        ? { rawTranscriptSeq: params.rawTranscriptSeq }
        : {}),
      ...(typeof params.totalRawMessages === "number"
        ? { totalRawMessages: params.totalRawMessages }
        : {}),
    });
    this.sentHistory = snapshot.history;
    this.rawTranscriptSeq = snapshot.rawTranscriptSeq;
    this.turnBoundaryPending = snapshot.turnBoundaryPending;
    this.transcriptPath = normalizeTranscriptPathForComparison(params.transcriptPath);
  }

  snapshot(): PaginatedSessionHistory {
    return this.sentHistory;
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
      maxChars: this.maxChars,
      turnBoundaryPending: hadPendingTurnBoundary,
    });
    this.turnBoundaryPending = nextProjection.turnBoundaryPending;
    // Projection can split, drop, or rewrite raw transcript messages. When one
    // raw append changes multiple visible rows, callers must refresh instead of
    // emitting a misleading single SSE item.
    const projectedMessages = toSessionHistoryMessages(
      projectChatDisplayMessages([...this.sentHistory.messages, nextMessage], {
        maxChars: this.maxChars,
      }),
    );
    if (projectedMessages.length > this.sentHistory.messages.length) {
      const addedMessages = projectedMessages.slice(this.sentHistory.messages.length);
      if (hadPendingTurnBoundary && !this.turnBoundaryPending && addedMessages[0]) {
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
      const projectedMessage = addedMessages[0];
      if (projectedMessage !== undefined) {
        const emittedMessage: SessionHistoryMessage =
          isMessageToolMirrorMessage(projectedMessage) ||
          resolveMessageSeq(projectedMessage) === undefined
            ? (attachOpenClawTranscriptMeta(projectedMessage, {
                seq: this.rawTranscriptSeq,
              }) as SessionHistoryMessage)
            : projectedMessage;
        const nextMessages = [...this.sentHistory.messages, emittedMessage];
        this.sentHistory = buildPaginatedSessionHistory({
          messages: nextMessages,
          hasMore: false,
        });
        return {
          message: emittedMessage,
          messageSeq: resolveMessageSeq(emittedMessage),
        };
      }
    }
    const [sanitizedMessage] = toSessionHistoryMessages(nextProjection.messages);
    if (!sanitizedMessage) {
      if (projectedMessages.length < this.sentHistory.messages.length) {
        this.sentHistory = buildPaginatedSessionHistory({
          messages: projectedMessages,
          hasMore: false,
        });
        return { shouldRefresh: true };
      }
      return null;
    }
    if (projectedMessages.length <= this.sentHistory.messages.length) {
      this.sentHistory = buildPaginatedSessionHistory({
        messages: projectedMessages,
        hasMore: false,
      });
      return { shouldRefresh: true };
    }
    const projectedMessage = projectedMessages.at(-1) ?? sanitizedMessage;
    const nextMessages = [...this.sentHistory.messages, projectedMessage];
    this.sentHistory = buildPaginatedSessionHistory({
      messages: nextMessages,
      hasMore: false,
    });
    return {
      message: projectedMessage,
      messageSeq: resolveMessageSeq(projectedMessage),
    };
  }

  shouldRefreshForTranscriptPath(updatePath: string | undefined): boolean {
    const nextPath = normalizeTranscriptPathForComparison(updatePath);
    return Boolean(this.transcriptPath && nextPath && this.transcriptPath !== nextPath);
  }

  async refreshAsync(): Promise<PaginatedSessionHistory> {
    const rawSnapshot = await this.readRawSnapshotAsync();
    const snapshot = this.buildSnapshot(rawSnapshot);
    this.rawTranscriptSeq = snapshot.rawTranscriptSeq;
    this.turnBoundaryPending = snapshot.turnBoundaryPending;
    this.transcriptPath = normalizeTranscriptPathForComparison(rawSnapshot.transcriptPath);
    this.sentHistory = snapshot.history;
    return snapshot.history;
  }

  private buildSnapshot(rawSnapshot: SessionHistoryRawSnapshot): SessionHistorySnapshot {
    return buildSessionHistorySnapshot({
      rawMessages: rawSnapshot.rawMessages,
      maxChars: this.maxChars,
      limit: this.limit,
      cursor: this.cursor,
      ...(typeof rawSnapshot.rawTranscriptSeq === "number"
        ? { rawTranscriptSeq: rawSnapshot.rawTranscriptSeq }
        : {}),
      ...(typeof rawSnapshot.totalRawMessages === "number"
        ? { totalRawMessages: rawSnapshot.totalRawMessages }
        : {}),
    });
  }

  private async readRawSnapshotAsync(): Promise<SessionHistoryRawSnapshot> {
    if (this.cursor === undefined && typeof this.limit === "number") {
      const snapshot = await readRecentSessionMessagesWithStatsAsync(
        {
          agentId: this.target.agentId,
          sessionEntry: this.target.sessionEntry,
          sessionId: this.target.sessionId,
          sessionKey: this.target.sessionKey,
          storePath: this.target.storePath,
        },
        {
          ...resolveSessionHistoryTailReadOptions(this.limit),
          allowResetArchiveFallback: true,
        },
      );
      return {
        rawMessages: snapshot.messages,
        rawTranscriptSeq: snapshot.totalMessages,
        totalRawMessages: snapshot.totalMessages,
        transcriptPath: snapshot.transcriptPath,
      };
    }
    const snapshot = await readSessionMessagesWithSourceAsync(
      {
        agentId: this.target.agentId,
        sessionEntry: this.target.sessionEntry,
        sessionId: this.target.sessionId,
        sessionKey: this.target.sessionKey,
        storePath: this.target.storePath,
      },
      {
        mode: "full",
        reason: "session history cursor pagination",
        allowResetArchiveFallback: true,
      },
    );
    return {
      rawMessages: snapshot.messages,
      transcriptPath: snapshot.transcriptPath,
    };
  }
}

function normalizeTranscriptPathForComparison(filePath: string | undefined): string | undefined {
  return typeof filePath === "string" ? resolveTranscriptPathForComparison(filePath) : undefined;
}
