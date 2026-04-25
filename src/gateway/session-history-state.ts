import { isHeartbeatOkResponse, isHeartbeatUserMessage } from "../auto-reply/heartbeat-filter.js";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import { stripEnvelopeFromMessages } from "./chat-sanitize.js";
import {
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  sanitizeChatHistoryMessages,
} from "./server-methods/chat.js";
import { attachOpenClawTranscriptMeta, readSessionMessages } from "./session-utils.js";

type SessionHistoryTranscriptMeta = {
  seq?: number;
};

export type SessionHistoryMessage = Record<string, unknown> & {
  __openclaw?: SessionHistoryTranscriptMeta;
};

export type PaginatedSessionHistory = {
  items: SessionHistoryMessage[];
  messages: SessionHistoryMessage[];
  nextCursor?: string;
  hasMore: boolean;
};

export type SessionHistorySnapshot = {
  history: PaginatedSessionHistory;
  rawTranscriptSeq: number;
};

type SessionHistoryTranscriptTarget = {
  sessionId: string;
  storePath?: string;
  sessionFile?: string;
};

type RoleContentMessage = {
  role: string;
  content?: unknown;
};

function asRoleContentMessage(message: SessionHistoryMessage): RoleContentMessage | null {
  const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
  if (!role) {
    return null;
  }
  return {
    role,
    ...(message.content !== undefined
      ? { content: message.content }
      : message.text !== undefined
        ? { content: message.text }
        : {}),
  };
}

function isEmptyTextOnlyContent(content: unknown): boolean {
  if (typeof content === "string") {
    return content.trim().length === 0;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  if (content.length === 0) {
    return true;
  }
  let sawText = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      return false;
    }
    const entry = block as { type?: unknown; text?: unknown };
    if (entry.type !== "text") {
      return false;
    }
    sawText = true;
    if (typeof entry.text !== "string" || entry.text.trim().length > 0) {
      return false;
    }
  }
  return sawText;
}

function shouldHideSanitizedHistoryMessage(message: SessionHistoryMessage): boolean {
  const roleContent = asRoleContentMessage(message);
  if (!roleContent) {
    return false;
  }
  if (roleContent.role === "user" && isEmptyTextOnlyContent(message.content ?? message.text)) {
    return true;
  }
  if (isHeartbeatUserMessage(roleContent, HEARTBEAT_PROMPT)) {
    return true;
  }
  return isHeartbeatOkResponse(roleContent);
}

function filterVisibleSessionHistoryMessages(
  messages: SessionHistoryMessage[],
): SessionHistoryMessage[] {
  if (messages.length === 0) {
    return messages;
  }
  let changed = false;
  const visible: SessionHistoryMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];
    if (!current) {
      continue;
    }
    const currentRoleContent = asRoleContentMessage(current);
    const next = messages[i + 1];
    const nextRoleContent = next ? asRoleContentMessage(next) : null;
    if (
      currentRoleContent &&
      nextRoleContent &&
      isHeartbeatUserMessage(currentRoleContent, HEARTBEAT_PROMPT) &&
      isHeartbeatOkResponse(nextRoleContent)
    ) {
      changed = true;
      i++;
      continue;
    }
    if (shouldHideSanitizedHistoryMessage(current)) {
      changed = true;
      continue;
    }
    visible.push(current);
  }
  return changed ? visible : messages;
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

export function resolveMessageSeq(message: SessionHistoryMessage | undefined): number | undefined {
  const seq = message?.__openclaw?.seq;
  return typeof seq === "number" && Number.isFinite(seq) && seq > 0 ? seq : undefined;
}

export function paginateSessionMessages(
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
}): SessionHistorySnapshot {
  const visibleMessages = filterVisibleSessionHistoryMessages(
    toSessionHistoryMessages(
      sanitizeChatHistoryMessages(
        stripEnvelopeFromMessages(params.rawMessages),
        params.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
      ),
    ),
  );
  const history = paginateSessionMessages(visibleMessages, params.limit, params.cursor);
  const rawHistoryMessages = toSessionHistoryMessages(params.rawMessages);
  return {
    history,
    rawTranscriptSeq: resolveMessageSeq(rawHistoryMessages.at(-1)) ?? rawHistoryMessages.length,
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
    });
  }

  constructor(params: {
    target: SessionHistoryTranscriptTarget;
    maxChars?: number;
    limit?: number;
    cursor?: string;
    initialRawMessages?: unknown[];
  }) {
    this.target = params.target;
    this.maxChars = params.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS;
    this.limit = params.limit;
    this.cursor = params.cursor;
    const rawMessages = params.initialRawMessages ?? this.readRawMessages();
    const snapshot = buildSessionHistorySnapshot({
      rawMessages,
      maxChars: this.maxChars,
      limit: this.limit,
      cursor: this.cursor,
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
  }): { message: unknown; messageSeq?: number } | null {
    if (this.limit !== undefined || this.cursor !== undefined) {
      return null;
    }
    this.rawTranscriptSeq += 1;
    const nextMessage = attachOpenClawTranscriptMeta(update.message, {
      ...(typeof update.messageId === "string" ? { id: update.messageId } : {}),
      seq: this.rawTranscriptSeq,
    });
    const sanitized = sanitizeChatHistoryMessages(
      stripEnvelopeFromMessages([nextMessage]),
      this.maxChars,
    );
    if (sanitized.length === 0) {
      return null;
    }
    const [sanitizedMessage] = toSessionHistoryMessages(sanitized);
    if (!sanitizedMessage) {
      return null;
    }
    if (shouldHideSanitizedHistoryMessage(sanitizedMessage)) {
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

  refresh(): PaginatedSessionHistory {
    const snapshot = buildSessionHistorySnapshot({
      rawMessages: this.readRawMessages(),
      maxChars: this.maxChars,
      limit: this.limit,
      cursor: this.cursor,
    });
    this.rawTranscriptSeq = snapshot.rawTranscriptSeq;
    this.sentHistory = snapshot.history;
    return snapshot.history;
  }

  private readRawMessages(): unknown[] {
    return readSessionMessages(
      this.target.sessionId,
      this.target.storePath,
      this.target.sessionFile,
    );
  }
}
