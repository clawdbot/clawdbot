import { isContextOverflowError } from "../agents/embedded-agent-helpers/context-overflow.js";
import { STREAM_ERROR_FALLBACK_TEXT } from "../agents/stream-message-shared.js";
import {
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  isAssistantTextContentType,
} from "./chat-display-projection.helpers.js";
import {
  filterVisibleProjectedHistoryMessages,
  mergeTtsSupplementMessages,
  projectSessionsSendInterSessionMessages,
  toProjectedMessages,
} from "./chat-display-projection.history.js";
import { mirrorMessageToolVisibleReplies } from "./chat-display-projection.message-tool.js";
import {
  sanitizeChatHistoryContentBlock,
  sanitizeChatHistoryMessage,
  sanitizeChatHistoryMessages,
  shouldDropAssistantHistoryMessage,
} from "./chat-display-projection.sanitize.js";
import { stripEnvelopeFromMessages } from "./chat-sanitize.js";
import { isSuppressedControlReplyText } from "./control-reply-text.js";

type ChatDisplayProjectionOptions = {
  maxChars?: number;
  stripEnvelope?: boolean;
  turnBoundaryPending?: boolean;
};

type ChatDisplayProjectionResult = {
  messages: Array<Record<string, unknown>>;
  turnBoundaryPending: boolean;
};

const GATEWAY_ASSISTANT_ERROR_FALLBACK_TEXT = "The agent run failed before producing a reply.";
const GATEWAY_ASSISTANT_CONTEXT_OVERFLOW_FALLBACK_TEXT =
  "Context overflow: this conversation is too large for the model. Try /compact, use /new to start a fresh session, or retry the command with a tighter output limit.";

function normalizeErrorSignal(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isContextOverflowErrorSignal(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return normalizeErrorSignal(value) === "context_overflow" || isContextOverflowError(value);
}

function isContextOverflowAssistantError(message: Record<string, unknown>): boolean {
  return (
    isContextOverflowErrorSignal(message.errorCode) ||
    isContextOverflowErrorSignal(message.errorType) ||
    isContextOverflowErrorSignal(message.errorMessage)
  );
}

function getAssistantErrorFallbackText(message: Record<string, unknown>): string {
  return isContextOverflowAssistantError(message)
    ? GATEWAY_ASSISTANT_CONTEXT_OVERFLOW_FALLBACK_TEXT
    : GATEWAY_ASSISTANT_ERROR_FALLBACK_TEXT;
}

function sanitizeAssistantErrorDisplayMessage(
  message: Record<string, unknown>,
): Record<string, unknown> {
  const { content, ...envelope } = message;
  const next = sanitizeChatHistoryMessage(envelope, Number.MAX_SAFE_INTEGER).message as Record<
    string,
    unknown
  >;
  next.content = Array.isArray(content)
    ? content
        .map(
          (block) =>
            sanitizeChatHistoryContentBlock(block, { maxChars: Number.MAX_SAFE_INTEGER }).block,
        )
        .filter((block) => {
          if (!block || typeof block !== "object" || Array.isArray(block)) {
            return true;
          }
          const type = (block as { type?: unknown }).type;
          return type !== "thinking" && type !== "reasoning" && type !== "redacted_thinking";
        })
    : content;
  delete next.diagnostics;
  delete next.errorBody;
  delete next.errorCode;
  delete next.errorMessage;
  delete next.errorType;
  return next;
}

function projectEmptyAssistantErrorMessages(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  let changed = false;
  const projected = messages.map((message) => {
    if (message.role !== "assistant" || message.stopReason !== "error") {
      return message;
    }
    const hasDisplayableStructuredContent =
      Array.isArray(message.content) &&
      message.content.some((block) => {
        if (!block || typeof block !== "object" || Array.isArray(block)) {
          return false;
        }
        const type = (block as { type?: unknown }).type;
        return (
          !isAssistantTextContentType(type) &&
          type !== "thinking" &&
          type !== "reasoning" &&
          type !== "redacted_thinking"
        );
      });
    if (hasDisplayableStructuredContent) {
      changed = true;
      return sanitizeAssistantErrorDisplayMessage(message);
    }
    const sanitized = sanitizeChatHistoryMessage(message, Number.MAX_SAFE_INTEGER)
      .message as Record<string, unknown>;
    const visibleTexts: string[] = [];
    if (typeof sanitized.content === "string") {
      visibleTexts.push(sanitized.content);
    } else if (Array.isArray(sanitized.content)) {
      for (const block of sanitized.content) {
        if (!block || typeof block !== "object" || Array.isArray(block)) {
          continue;
        }
        const entry = block as { type?: unknown; text?: unknown };
        if (isAssistantTextContentType(entry.type) && typeof entry.text === "string") {
          visibleTexts.push(entry.text);
        }
      }
    }
    if (typeof sanitized.text === "string") {
      visibleTexts.push(sanitized.text);
    }
    const nonEmptyVisibleTexts = visibleTexts.map((text) => text.trim()).filter(Boolean);
    const hasVisibleReplyText = nonEmptyVisibleTexts.some(
      (text) => text !== STREAM_ERROR_FALLBACK_TEXT && !isSuppressedControlReplyText(text),
    );
    if (!shouldDropAssistantHistoryMessage(sanitized) && hasVisibleReplyText) {
      changed = true;
      return sanitizeAssistantErrorDisplayMessage(message);
    }
    changed = true;
    const next: Record<string, unknown> = {
      ...sanitized,
      content: [{ type: "text", text: getAssistantErrorFallbackText(message) }],
    };
    delete next.diagnostics;
    delete next.errorBody;
    delete next.errorCode;
    delete next.errorMessage;
    delete next.errorType;
    delete next.phase;
    delete next.text;
    return next;
  });
  return changed ? projected : messages;
}

export function projectChatDisplayMessagesWithState(
  messages: unknown[],
  options?: ChatDisplayProjectionOptions,
): ChatDisplayProjectionResult {
  const source = options?.stripEnvelope === false ? messages : stripEnvelopeFromMessages(messages);
  const mirrored = mirrorMessageToolVisibleReplies(source);
  const projectedErrors = projectEmptyAssistantErrorMessages(toProjectedMessages(mirrored));
  const filtered = filterVisibleProjectedHistoryMessages(
    projectSessionsSendInterSessionMessages(
      toProjectedMessages(sanitizeChatHistoryMessages(projectedErrors, Number.MAX_SAFE_INTEGER)),
    ),
    options?.turnBoundaryPending,
  );
  return {
    messages: sanitizeChatHistoryMessages(
      mergeTtsSupplementMessages(filtered.messages),
      options?.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
    ) as Array<Record<string, unknown>>,
    turnBoundaryPending: filtered.turnBoundaryPending,
  };
}

export function projectChatDisplayMessages(
  messages: unknown[],
  options?: ChatDisplayProjectionOptions,
): Array<Record<string, unknown>> {
  return projectChatDisplayMessagesWithState(messages, options).messages;
}

function limitChatDisplayMessages<T>(messages: T[], maxMessages?: number): T[] {
  if (
    typeof maxMessages !== "number" ||
    !Number.isFinite(maxMessages) ||
    maxMessages <= 0 ||
    messages.length <= maxMessages
  ) {
    return messages;
  }
  return messages.slice(-Math.floor(maxMessages));
}

export function projectRecentChatDisplayMessages(
  messages: unknown[],
  options?: ChatDisplayProjectionOptions & { maxMessages?: number },
): Array<Record<string, unknown>> {
  return limitChatDisplayMessages(
    projectChatDisplayMessages(messages, options),
    options?.maxMessages,
  );
}

export function projectChatDisplayMessage(
  message: unknown,
  options?: ChatDisplayProjectionOptions,
): Record<string, unknown> | undefined {
  return projectChatDisplayMessages([message], options)[0];
}
