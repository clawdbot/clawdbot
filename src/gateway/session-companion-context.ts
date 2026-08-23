import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  extractStoredAssistantText,
  stripToolMessages,
} from "../agents/tools/chat-history-text.js";
import {
  isSessionTranscriptProjectionUnavailableError,
  readSessionTranscriptBoundedContextMessageTailPage,
} from "../config/sessions/session-accessor.sqlite-active-events.js";
import { redactToolPayloadText } from "../logging/redact.js";
import type {
  SessionCompanionContextMessage,
  SessionCompanionPreparedContext,
} from "./session-companion-state.js";
import { loadSessionEntryReadOnly } from "./session-utils.js";

const CONTEXT_MAX_MESSAGES = 40;
const CONTEXT_MAX_BYTES = 24 * 1024;
const CONTEXT_MESSAGE_MAX_CHARS = 4000;
const CONTEXT_READ_MAX_SCANNED_MESSAGES = 4096;
const CONTEXT_READ_MAX_BYTES = 1024 * 1024;

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

function sanitizeContextMessages(
  messages: unknown[],
  contextSummary?: { text: string; ts: number },
): SessionCompanionContextMessage[] {
  const sanitized = stripToolMessages(messages)
    .slice(-CONTEXT_MAX_MESSAGES)
    .flatMap((message): SessionCompanionContextMessage[] => {
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
  const summaryText = contextSummary ? normalizeContextText(contextSummary.text) : "";
  const summaryMessage = summaryText
    ? ({ role: "summary", text: summaryText, ts: contextSummary?.ts ?? 0 } as const)
    : undefined;
  const selected: SessionCompanionContextMessage[] = summaryMessage ? [summaryMessage] : [];
  let bytes =
    2 + (summaryMessage ? Buffer.byteLength(JSON.stringify(summaryMessage), "utf8") + 1 : 0);
  for (const message of sanitized.toReversed()) {
    if (selected.length >= CONTEXT_MAX_MESSAGES) {
      break;
    }
    const messageBytes = Buffer.byteLength(JSON.stringify(message), "utf8") + 1;
    if (bytes + messageBytes > CONTEXT_MAX_BYTES) {
      break;
    }
    selected.splice(summaryMessage ? 1 : 0, 0, message);
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
  const loaded = loadSessionEntryReadOnly(params.sessionKey, { agentId: params.agentId });
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
    const page = readSessionTranscriptBoundedContextMessageTailPage(scope, {
      maxBytes: CONTEXT_READ_MAX_BYTES,
      maxMessages: CONTEXT_MAX_MESSAGES,
      maxScannedMessages: CONTEXT_READ_MAX_SCANNED_MESSAGES,
    });
    if (!page.authoritative || params.signal?.aborted) {
      return { kind: "unavailable" };
    }
    const selected = sanitizeContextMessages(readPageMessages(page.events), page.contextSummary);
    return {
      kind: "ready",
      context: {
        empty: page.empty,
        messages: selected,
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
    loadSessionEntryReadOnly(sessionKey, { agentId }).entry?.sessionId?.trim() || undefined,
  read: readSessionCompanionContext,
};
