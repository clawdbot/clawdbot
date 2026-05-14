import { asPositiveSafeInteger } from "../shared/number-coercion.js";
import {
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  projectChatDisplayMessages,
} from "./chat-display-projection.js";
import {
  attachOpenClawTranscriptMeta,
  readRecentSessionMessagesWithStatsAsync,
  readSessionMessagesAsync,
} from "./session-utils.js";

type SessionHistoryTranscriptMeta = {
  seq?: number;
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
};

type InlineSessionHistoryAppend = {
  message?: unknown;
  messageSeq?: number;
  shouldRefresh?: boolean;
};

type SessionHistoryTranscriptTarget = {
  sessionId: string;
  storePath?: string;
  sessionFile?: string;
};

type SessionHistoryRawSnapshot = {
  rawMessages: unknown[];
  rawTranscriptSeq?: number;
  totalRawMessages?: number;
};

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
  const value = Number.parseInt(normalized, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
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
  return asPositiveSafeInteger(message?.__openclaw?.seq);
}

function paginateSessionMessages(
  messages: SessionHistoryMessage[],
  limit: number | undefined,
  cursor: string | undefined,
): PaginatedSessionHistory {
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

export function buildSessionHistorySnapshot(params: {
  rawMessages: unknown[];
  maxChars?: number;
  limit?: number;
  cursor?: string;
  rawTranscriptSeq?: number;
  totalRawMessages?: number;
}): SessionHistorySnapshot {
  const visibleMessages = toSessionHistoryMessages(
    projectChatDisplayMessages(params.rawMessages, {
      maxChars: params.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
    }),
  );
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
  };
}

export class SessionHistorySseState {
  private readonly target: SessionHistoryTranscriptTarget;
  private readonly maxChars: number;
  private readonly limit: number | undefined;
  private readonly cursor: string | undefined;
  private sentHistory: PaginatedSessionHistory;
  private rawTranscriptSeq: number;

  static fromRawSnapshot(params: {
    target: SessionHistoryTranscriptTarget;
    rawMessages: unknown[];
    rawTranscriptSeq?: number;
    totalRawMessages?: number;
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
  }) {
    this.target = params.target;
    this.maxChars = params.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS;
    this.limit = params.limit;
    this.cursor = params.cursor;
    const rawSnapshot = {
      rawMessages: params.initialRawMessages,
      ...(typeof params.rawTranscriptSeq === "number"
        ? { rawTranscriptSeq: params.rawTranscriptSeq }
        : {}),
      ...(typeof params.totalRawMessages === "number"
        ? { totalRawMessages: params.totalRawMessages }
        : {}),
    };
    const snapshot = buildSessionHistorySnapshot({
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
    this.sentHistory = snapshot.history;
    this.rawTranscriptSeq = snapshot.rawTranscriptSeq;
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
    const nextMessage = attachOpenClawTranscriptMeta(update.message, {
      ...(typeof update.messageId === "string" ? { id: update.messageId } : {}),
      seq: this.rawTranscriptSeq,
    });
    const [sanitizedMessage] = toSessionHistoryMessages(
      projectChatDisplayMessages([nextMessage], { maxChars: this.maxChars }),
    );
    if (!sanitizedMessage) {
      return null;
    }
    const nextMessages = [...this.sentHistory.messages, sanitizedMessage];
    this.sentHistory = buildPaginatedSessionHistory({
      messages: nextMessages,
      hasMore: false,
    });
    return {
      message: sanitizedMessage,
      messageSeq: resolveMessageSeq(sanitizedMessage),
    };
  }

  async refreshAsync(): Promise<PaginatedSessionHistory> {
    const rawSnapshot = await this.readRawSnapshotAsync();
    const snapshot = buildSessionHistorySnapshot({
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
    this.rawTranscriptSeq = snapshot.rawTranscriptSeq;
    this.sentHistory = snapshot.history;
    return snapshot.history;
  }

  private async readRawSnapshotAsync(): Promise<SessionHistoryRawSnapshot> {
    if (this.cursor === undefined && typeof this.limit === "number") {
      const snapshot = await readRecentSessionMessagesWithStatsAsync(
        this.target.sessionId,
        this.target.storePath,
        this.target.sessionFile,
        {
          ...resolveSessionHistoryTailReadOptions(this.limit),
        },
      );
      return {
        rawMessages: snapshot.messages,
        rawTranscriptSeq: snapshot.totalMessages,
        totalRawMessages: snapshot.totalMessages,
      };
    }
    return {
      rawMessages: await readSessionMessagesAsync(
        this.target.sessionId,
        this.target.storePath,
        this.target.sessionFile,
        {
          mode: "full",
          reason: "session history cursor pagination",
        },
      ),
    };
  }
}
