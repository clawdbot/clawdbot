import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty as normalizeErrorSignal } from "@openclaw/normalization-core/string-coerce";
import { isContextOverflowError } from "../agents/failover/classify.js";
import { STREAM_ERROR_FALLBACK_TEXT } from "../agents/stream-message-shared.js";
import { hasRawToolValidationOutput } from "../agents/tool-error-summary.js";
import { readTranscriptSenderIdentity } from "../chat/sender-identity.js";
import {
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  extractAssistantTextForSilentCheck,
  hasAssistantDisplayableNonTextContent,
  hasAssistantNonTextContent,
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
import type {
  CurrentUserProfileDisplay,
  CurrentUserProfileDisplayResolver,
} from "./current-user-profile-display.js";

type ChatDisplayProjectionOptions = {
  includeCommentaryFallbacks?: boolean;
  maxChars?: number;
  resolveCurrentUserProfileDisplay?: CurrentUserProfileDisplayResolver;
  stripEnvelope?: boolean;
  turnBoundaryPending?: boolean;
  streamErrorFallbackPending?: boolean;
};

function projectCurrentUserProfileAvatars(
  messages: Array<Record<string, unknown>>,
  resolveDisplay: CurrentUserProfileDisplayResolver | undefined,
): Array<Record<string, unknown>> {
  if (!resolveDisplay) {
    return messages;
  }
  const displayBySenderId = new Map<string, CurrentUserProfileDisplay>();
  let changed = false;
  const projected = messages.map((message) => {
    if (message.role !== "user") {
      return message;
    }
    const metadata = asOptionalRecord(message["__openclaw"]);
    if (!metadata) {
      return message;
    }
    const identity = readTranscriptSenderIdentity(metadata.senderIdentity);
    if (identity?.type !== "profile") {
      return message;
    }
    const senderId = identity.id;
    let display = displayBySenderId.get(senderId);
    if (!display) {
      display = resolveDisplay(senderId);
      displayBySenderId.set(senderId, display);
    }
    if (display.kind === "unresolved") {
      return message;
    }
    if (
      metadata.senderProfileAvatarUrl === display.avatarUrl &&
      identity.id === display.profileId
    ) {
      return message;
    }
    changed = true;
    return {
      ...message,
      __openclaw: {
        ...metadata,
        senderIdentity: { type: "profile", id: display.profileId },
        senderProfileAvatarUrl: display.avatarUrl,
      },
    };
  });
  return changed ? projected : messages;
}

type ChatDisplayProjectionResult = {
  messages: Array<Record<string, unknown>>;
  turnBoundaryPending: boolean;
  streamErrorFallbackPending: boolean;
  streamErrorFallbackRepaired: boolean;
};

const GATEWAY_ASSISTANT_ERROR_FALLBACK_TEXT = "The agent run failed before producing a reply.";
const GATEWAY_ASSISTANT_CONTEXT_OVERFLOW_FALLBACK_TEXT =
  "Context overflow: this conversation is too large for the model. Try /compact, use /new to start a fresh session, or retry the command with a tighter output limit.";

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
  if (Array.isArray(content)) {
    let firstTextBlock = true;
    next.content = content.flatMap((block) => {
      const sanitized = sanitizeChatHistoryContentBlock(block, {
        maxChars: Number.MAX_SAFE_INTEGER,
      }).block;
      if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) {
        return [sanitized];
      }
      const entry = sanitized as { type?: unknown; text?: unknown };
      if (
        entry.type === "thinking" ||
        entry.type === "reasoning" ||
        entry.type === "redacted_thinking"
      ) {
        return [];
      }
      if (!firstTextBlock || !isAssistantTextContentType(entry.type)) {
        return [sanitized];
      }
      firstTextBlock = false;
      if (typeof entry.text !== "string" || !entry.text.startsWith(STREAM_ERROR_FALLBACK_TEXT)) {
        return [sanitized];
      }
      const replyText = entry.text.slice(STREAM_ERROR_FALLBACK_TEXT.length);
      return replyText ? [{ ...entry, text: replyText }] : [];
    });
  } else {
    next.content =
      typeof content === "string" && content.startsWith(STREAM_ERROR_FALLBACK_TEXT)
        ? content.slice(STREAM_ERROR_FALLBACK_TEXT.length)
        : content;
  }
  if (typeof next.text === "string" && next.text.startsWith(STREAM_ERROR_FALLBACK_TEXT)) {
    next.text = next.text.slice(STREAM_ERROR_FALLBACK_TEXT.length);
  }
  delete next.diagnostics;
  delete next.errorBody;
  delete next.errorCode;
  delete next.errorMessage;
  delete next.errorType;
  return next;
}

function isPureStreamErrorFallbackAssistantMessage(message: Record<string, unknown>): boolean {
  if (message.role !== "assistant" || message.stopReason !== "error") {
    return false;
  }
  const text = extractAssistantTextForSilentCheck(message);
  return (
    text !== undefined &&
    text.trim() === STREAM_ERROR_FALLBACK_TEXT &&
    !hasAssistantNonTextContent(message)
  );
}

function hasVisibleAssistantDisplayContent(message: Record<string, unknown>): boolean {
  if (
    message.role !== "assistant" ||
    message.display === false ||
    isPureStreamErrorFallbackAssistantMessage(message)
  ) {
    return false;
  }
  const sanitized = sanitizeChatHistoryMessage(message, Number.MAX_SAFE_INTEGER).message as Record<
    string,
    unknown
  >;
  if (shouldDropAssistantHistoryMessage(sanitized)) {
    return false;
  }
  if (hasAssistantDisplayableNonTextContent(sanitized)) {
    return true;
  }
  const text = extractAssistantTextForSilentCheck(sanitized);
  return Boolean(text?.trim()) && !isSuppressedControlReplyText(text ?? "");
}

function projectRepairedStreamErrorFallbackMessages(
  messages: Array<Record<string, unknown>>,
  initialPending = false,
): {
  messages: Array<Record<string, unknown>>;
  pending: boolean;
  repaired: boolean;
} {
  let pending = initialPending;
  let repaired = false;
  let changed = false;
  let pendingIndexes: number[] = [];
  const repairedIndexes = new Set<number>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (message.role === "user") {
      pending = false;
      pendingIndexes = [];
      continue;
    }
    if (isPureStreamErrorFallbackAssistantMessage(message)) {
      pending = true;
      pendingIndexes.push(index);
      continue;
    }
    if (!pending || !hasVisibleAssistantDisplayContent(message)) {
      continue;
    }
    repaired = true;
    pending = false;
    if (pendingIndexes.length > 0) {
      changed = true;
      for (const pendingIndex of pendingIndexes) {
        repairedIndexes.add(pendingIndex);
      }
      pendingIndexes = [];
    }
  }
  return {
    messages: changed ? messages.filter((_, index) => !repairedIndexes.has(index)) : messages,
    pending,
    repaired,
  };
}

function projectEmptyAssistantErrorMessages(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  let changed = false;
  const projected = messages.map((message) => {
    if (message.role !== "assistant" || message.stopReason !== "error") {
      return message;
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
    const hasUnsafeValidationOutput = nonEmptyVisibleTexts.some(hasRawToolValidationOutput);
    const hasDisplayableStructuredContent = hasAssistantDisplayableNonTextContent(message);
    if (hasDisplayableStructuredContent && !hasUnsafeValidationOutput) {
      changed = true;
      return sanitizeAssistantErrorDisplayMessage(message);
    }
    const hasVisibleReplyText = nonEmptyVisibleTexts.some(
      (text) => text !== STREAM_ERROR_FALLBACK_TEXT && !isSuppressedControlReplyText(text),
    );
    if (
      !hasUnsafeValidationOutput &&
      !shouldDropAssistantHistoryMessage(sanitized) &&
      hasVisibleReplyText
    ) {
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
  const repairedStreamErrors = projectRepairedStreamErrorFallbackMessages(
    toProjectedMessages(mirrored),
    options?.streamErrorFallbackPending,
  );
  const projectedErrors = projectEmptyAssistantErrorMessages(repairedStreamErrors.messages);
  const filtered = filterVisibleProjectedHistoryMessages(
    projectSessionsSendInterSessionMessages(
      toProjectedMessages(
        sanitizeChatHistoryMessages(projectedErrors, Number.MAX_SAFE_INTEGER, {
          includeCommentaryFallbacks: options?.includeCommentaryFallbacks,
        }),
      ),
    ),
    options?.turnBoundaryPending,
  );
  const displayMessages = sanitizeChatHistoryMessages(
    mergeTtsSupplementMessages(filtered.messages),
    options?.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  ) as Array<Record<string, unknown>>;
  return {
    messages: projectCurrentUserProfileAvatars(
      displayMessages,
      options?.resolveCurrentUserProfileDisplay,
    ),
    turnBoundaryPending: filtered.turnBoundaryPending,
    streamErrorFallbackPending: repairedStreamErrors.pending,
    streamErrorFallbackRepaired: repairedStreamErrors.repaired,
  };
}

export function projectChatDisplayMessages(
  messages: unknown[],
  options?: ChatDisplayProjectionOptions,
): Array<Record<string, unknown>> {
  return projectChatDisplayMessagesWithState(messages, options).messages;
}

export function projectChatDisplayMessage(
  message: unknown,
  options?: ChatDisplayProjectionOptions,
): Record<string, unknown> | undefined {
  return projectChatDisplayMessages([message], options)[0];
}
