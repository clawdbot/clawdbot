import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  extractStoredAssistantText,
  stripToolMessages,
} from "../agents/tools/chat-history-text.js";
import {
  isSessionTranscriptProjectionUnavailableError,
  readSessionTranscriptBoundedMessageTailPage,
} from "../config/sessions/session-accessor.sqlite-active-events.js";
import { redactToolPayloadText } from "../logging/redact.js";
import type {
  SessionCompanionContextMessage,
  SessionCompanionPreparedContext,
} from "./session-companion-state.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";

const CONTEXT_MAX_MESSAGES = 40;
const CONTEXT_MAX_BYTES = 24 * 1024;
const CONTEXT_MESSAGE_MAX_CHARS = 4000;
const CONTEXT_READ_MAX_SCANNED_MESSAGES = 4096;
const CONTEXT_READ_MAX_BYTES = 1024 * 1024;
const CONTEXT_READ_PAGE_MESSAGES = 128;

type SessionCompanionContextReadResult =
  | { kind: "ready"; context: SessionCompanionPreparedContext }
  | { kind: "missing" }
  | { kind: "unavailable" };

export type SessionCompanionContextReader = {
  currentSessionId: (params: { agentId: string; sessionKey: string }) => string | undefined;
  read: (params: {
    agentId: string;
    sessionKey: string;
    signal?: AbortSignal;
  }) => Promise<SessionCompanionContextReadResult>;
};

function normalizeContextText(value: string): string {
  return truncateUtf16Safe(
    redactToolPayloadText(value).replace(/\s+/gu, " ").trim(),
    CONTEXT_MESSAGE_MAX_CHARS,
  );
}

function extractUserText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return normalizeContextText(content) || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .flatMap((block) => {
      if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "text") {
        return [];
      }
      const blockText = (block as { text?: unknown }).text;
      return typeof blockText === "string" ? [blockText] : [];
    })
    .join("\n");
  return normalizeContextText(text) || undefined;
}

function readMessageTimestamp(message: unknown): number {
  if (!message || typeof message !== "object") {
    return 0;
  }
  const value = (message as { timestamp?: unknown }).timestamp;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function sanitizeContextMessages(messages: unknown[]): SessionCompanionContextMessage[] {
  return stripToolMessages(messages).flatMap((message): SessionCompanionContextMessage[] => {
    if (!message || typeof message !== "object") {
      return [];
    }
    const role = (message as { role?: unknown }).role;
    const text =
      role === "assistant"
        ? normalizeContextText(extractStoredAssistantText(message) ?? "")
        : role === "user"
          ? extractUserText(message)
          : undefined;
    return text && (role === "assistant" || role === "user")
      ? [{ role, text, ts: readMessageTimestamp(message) }]
      : [];
  });
}

function selectContextMessages(messages: SessionCompanionContextMessage[]) {
  const selected: SessionCompanionContextMessage[] = [];
  let bytes = 2;
  for (const message of messages.toReversed()) {
    if (selected.length >= CONTEXT_MAX_MESSAGES) {
      break;
    }
    const messageBytes = Buffer.byteLength(JSON.stringify(message), "utf8") + 1;
    if (bytes + messageBytes > CONTEXT_MAX_BYTES) {
      break;
    }
    selected.unshift(message);
    bytes += messageBytes;
  }
  return selected;
}

function readPageMessages(events: Array<{ event: unknown }>): unknown[] {
  return events.flatMap(({ event }) => {
    if (!event || typeof event !== "object") {
      return [];
    }
    const message = (event as { message?: unknown }).message;
    return message && typeof message === "object" ? [message] : [];
  });
}

async function readSessionCompanionContext(params: {
  agentId: string;
  sessionKey: string;
  signal?: AbortSignal;
}): Promise<SessionCompanionContextReadResult> {
  const loaded = loadGatewaySessionEntryReadOnly(params.sessionKey, { agentId: params.agentId });
  const sessionId = loaded.entry?.sessionId?.trim();
  if (!sessionId) {
    return { kind: "missing" };
  }
  try {
    const scope = {
      agentId: params.agentId,
      sessionId,
      sessionKey: params.sessionKey,
      storePath: loaded.storePath,
    };
    if (params.signal?.aborted) {
      return { kind: "unavailable" };
    }
    let offset = 0;
    let rawBytes = 0;
    let scannedMessages = 0;
    let totalMessages = 0;
    let snapshot:
      | {
          activeLeafEntryId?: string | null;
          generation?: string;
          indexedSeq: number;
          totalMessages: number;
        }
      | undefined;
    let contextMessages: SessionCompanionContextMessage[] = [];
    while (
      contextMessages.length < CONTEXT_MAX_MESSAGES &&
      scannedMessages < CONTEXT_READ_MAX_SCANNED_MESSAGES
    ) {
      const page = readSessionTranscriptBoundedMessageTailPage(scope, {
        maxBytes: CONTEXT_READ_MAX_BYTES - rawBytes,
        maxMessages: Math.min(
          CONTEXT_READ_PAGE_MESSAGES,
          CONTEXT_READ_MAX_SCANNED_MESSAGES - scannedMessages,
        ),
        offset,
      });
      if (params.signal?.aborted || page.events.length !== page.scannedMessages) {
        return { kind: "unavailable" };
      }
      const pageSnapshot = {
        activeLeafEntryId: page.activeLeafEntryId,
        generation: page.snapshot.generation,
        indexedSeq: page.snapshot.indexedSeq,
        totalMessages: page.totalMessages,
      };
      snapshot ??= pageSnapshot;
      if (
        pageSnapshot.activeLeafEntryId !== snapshot.activeLeafEntryId ||
        pageSnapshot.generation !== snapshot.generation ||
        pageSnapshot.indexedSeq !== snapshot.indexedSeq ||
        pageSnapshot.totalMessages !== snapshot.totalMessages
      ) {
        return { kind: "unavailable" };
      }
      totalMessages = page.totalMessages;
      rawBytes += page.serializedBytes;
      scannedMessages += page.scannedMessages;
      offset += page.scannedMessages;
      contextMessages = [
        ...sanitizeContextMessages(readPageMessages(page.events)),
        ...contextMessages,
      ].slice(-CONTEXT_MAX_MESSAGES);
      if (page.scannedMessages === 0 || offset >= totalMessages) {
        break;
      }
    }
    if (contextMessages.length < CONTEXT_MAX_MESSAGES && offset < totalMessages) {
      return { kind: "unavailable" };
    }
    const fence = readSessionTranscriptBoundedMessageTailPage(scope, {
      maxBytes: 0,
      maxMessages: 0,
      offset: 0,
    });
    if (
      params.signal?.aborted ||
      !snapshot ||
      fence.activeLeafEntryId !== snapshot.activeLeafEntryId ||
      fence.snapshot.generation !== snapshot.generation ||
      fence.snapshot.indexedSeq !== snapshot.indexedSeq ||
      fence.totalMessages !== snapshot.totalMessages
    ) {
      return { kind: "unavailable" };
    }
    return {
      kind: "ready",
      context: {
        empty: totalMessages === 0,
        messages: selectContextMessages(contextMessages),
        sessionId,
      },
    };
  } catch (error) {
    if (isSessionTranscriptProjectionUnavailableError(error)) {
      return { kind: "unavailable" };
    }
    return { kind: "unavailable" };
  }
}

export const defaultSessionCompanionContextReader: SessionCompanionContextReader = {
  currentSessionId: ({ agentId, sessionKey }) =>
    loadGatewaySessionEntryReadOnly(sessionKey, { agentId }).entry?.sessionId?.trim() || undefined,
  read: readSessionCompanionContext,
};
