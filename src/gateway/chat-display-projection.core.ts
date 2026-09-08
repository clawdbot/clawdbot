import { GATEWAY_ASSISTANT_ERROR_FALLBACK_TEXT } from "@openclaw/gateway-protocol/gateway-error-details";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty as normalizeErrorSignal } from "@openclaw/normalization-core/string-coerce";
import { renderAssistantRequestFailureCopy } from "../agents/failover/assistant-request-failure-copy.js";
import { isContextOverflowError } from "../agents/failover/classify.js";
import { STREAM_ERROR_FALLBACK_TEXT } from "../agents/stream-message-shared.js";
import { readTranscriptSenderIdentity } from "../chat/sender-identity.js";
import { classifyGatewayStorageFailure } from "../infra/sqlite-error-diagnostics.js";
import {
  readNestedToolActivity,
  nestedToolActivityContent,
} from "../sessions/nested-tool-activity.js";
import { readSessionTranscriptRunId } from "../sessions/transcript-events.js";
import { formatProviderRefusalText } from "../shared/assistant-error-format.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../shared/transcript-only-openclaw-assistant.js";
import {
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  extractAssistantTextForSilentCheck,
  hasAssistantDisplayableNonTextContent,
  hasAssistantNonTextContent,
  hasTranscriptMediaFacts,
  isAssistantTextContentType,
  isAssistantInternalReasoningContentType,
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
  assistantErrorPending?: boolean;
};

/** Keep profile display reads local to one history page or event projection operation. */
export function createCurrentUserProfileMessageProjector(
  resolveDisplay: CurrentUserProfileDisplayResolver,
) {
  const displayBySenderId = new Map<string, CurrentUserProfileDisplay>();
  return (message: Record<string, unknown>): Record<string, unknown> => {
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
    return {
      ...message,
      __openclaw: {
        ...metadata,
        senderIdentity: { type: "profile", id: display.profileId },
        senderProfileAvatarUrl: display.avatarUrl,
      },
    };
  };
}

function projectCurrentUserProfileAvatars(
  messages: Array<Record<string, unknown>>,
  resolveDisplay: CurrentUserProfileDisplayResolver | undefined,
): Array<Record<string, unknown>> {
  if (!resolveDisplay) {
    return messages;
  }
  const project = createCurrentUserProfileMessageProjector(resolveDisplay);
  let changed = false;
  const projected = messages.map((message) => {
    const row = project(message);
    changed ||= row !== message;
    return row;
  });
  return changed ? projected : messages;
}

type ChatDisplayProjectionResult = {
  messages: Array<Record<string, unknown>>;
  turnBoundaryPending: boolean;
  assistantErrorPending: boolean;
  assistantErrorRecoveryObserved: boolean;
};

const GATEWAY_ASSISTANT_CONTEXT_OVERFLOW_FALLBACK_TEXT =
  "Context overflow: this conversation is too large for the model. Try /compact, use /new to start a fresh session, or retry the command with a tighter output limit.";

function isContextOverflowErrorSignal(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return (
    normalizeErrorSignal(value) === "context_overflow" ||
    isContextOverflowError(value, { providerPlugin: null })
  );
}

function isContextOverflowAssistantError(message: Record<string, unknown>): boolean {
  return (
    isContextOverflowErrorSignal(message.errorCode) ||
    isContextOverflowErrorSignal(message.errorType) ||
    isContextOverflowErrorSignal(message.errorMessage)
  );
}

function getAssistantErrorFallbackText(message: Record<string, unknown>): string {
  return (
    formatProviderRefusalText(message) ??
    renderAssistantRequestFailureCopy({
      storageFailure: classifyGatewayStorageFailure(message),
      code: typeof message.errorCode === "string" ? message.errorCode : undefined,
    }) ??
    (isContextOverflowAssistantError(message)
      ? GATEWAY_ASSISTANT_CONTEXT_OVERFLOW_FALLBACK_TEXT
      : GATEWAY_ASSISTANT_ERROR_FALLBACK_TEXT)
  );
}

function sanitizeAssistantErrorDisplayMessage(
  message: Record<string, unknown>,
): Record<string, unknown> {
  const { content, ...envelope } = message;
  let next = sanitizeChatHistoryMessage(envelope, Number.MAX_SAFE_INTEGER).message as Record<
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
      if (isAssistantInternalReasoningContentType(entry.type)) {
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
  const terminalCopy = renderAssistantRequestFailureCopy({
    code: typeof message.errorCode === "string" ? message.errorCode : undefined,
  });
  if (terminalCopy) {
    // Apply the normal visibility rules before adding host-owned failure copy.
    // Put it first in surviving text so phase filtering and display caps retain it.
    // SAFETY: Sanitizing a record only clones/filters its fields; its envelope remains a record.
    next = sanitizeChatHistoryMessage(next, Number.MAX_SAFE_INTEGER).message as Record<
      string,
      unknown
    >;
    if (shouldDropAssistantHistoryMessage(next)) {
      next.content = [];
      delete next.text;
      delete next.phase;
    }
    const displayContent: unknown[] = Array.isArray(next.content)
      ? [...next.content]
      : typeof next.content === "string"
        ? [{ type: "text", text: next.content }]
        : [];
    const prependText = (text: string) => {
      const alreadyPresent = displayContent.some((block) => {
        const entry = asOptionalRecord(block);
        return (
          entry &&
          isAssistantTextContentType(entry.type) &&
          typeof entry.text === "string" &&
          entry.text.includes(text)
        );
      });
      if (!text || alreadyPresent) {
        return;
      }
      const textIndex = displayContent.findIndex((block) => {
        const entry = asOptionalRecord(block);
        return entry && isAssistantTextContentType(entry.type) && typeof entry.text === "string";
      });
      const previous = textIndex >= 0 ? asOptionalRecord(displayContent[textIndex]) : undefined;
      if (previous) {
        displayContent[textIndex] = {
          ...previous,
          text: [text, previous.text].filter(Boolean).join("\n\n"),
        };
      } else {
        displayContent.push({ type: "text", text });
      }
    };
    if (typeof next.text === "string") {
      prependText(next.text);
    }
    prependText(getAssistantErrorFallbackText(message));
    next.content = displayContent;
    delete next.text;
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
    !hasAssistantNonTextContent(message) &&
    !hasTranscriptMediaFacts(message)
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
  if (hasAssistantDisplayableNonTextContent(sanitized) || hasTranscriptMediaFacts(sanitized)) {
    return true;
  }
  return hasVisibleAssistantReplyText(sanitized);
}

function hasVisibleAssistantReplyText(message: Record<string, unknown>): boolean {
  const texts = Array.isArray(message.content)
    ? message.content.flatMap((block) => {
        const entry = asOptionalRecord(block);
        return isAssistantTextContentType(entry?.type) ? [entry?.text] : [];
      })
    : [message.content];
  return [...texts, message.text].some((text) => {
    if (typeof text !== "string") {
      return false;
    }
    const visible = text.trim();
    return (
      visible.length > 0 &&
      visible !== STREAM_ERROR_FALLBACK_TEXT &&
      !isSuppressedControlReplyText(visible)
    );
  });
}

export function isPendingAssistantError(value: unknown): boolean {
  const message = asOptionalRecord(value);
  return (
    message?.role === "assistant" &&
    message.stopReason === "error" &&
    (isPureStreamErrorFallbackAssistantMessage(message) ||
      (Boolean(readSessionTranscriptRunId(message)) &&
        !hasAssistantDisplayableNonTextContent(message) &&
        !hasVisibleAssistantDisplayContent(message)))
  );
}

function projectRecoveredAssistantErrors(
  messages: Array<Record<string, unknown>>,
  initialPending = false,
): {
  messages: Array<Record<string, unknown>>;
  pending: boolean;
  recoveryObserved: boolean;
} {
  let unseenPending = initialPending;
  let recoveryObserved = false;
  let pendingIndexes: number[] = [];
  const repairedIndexes = new Set<number>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (message.role === "user") {
      unseenPending = false;
      pendingIndexes = [];
      continue;
    }
    if (isPendingAssistantError(message)) {
      pendingIndexes.push(index);
      continue;
    }
    if (
      (!unseenPending && pendingIndexes.length === 0) ||
      !hasVisibleAssistantDisplayContent(message)
    ) {
      continue;
    }
    // An incremental reader carries only a pending bit. It must reload raw
    // history before deciding which previously emitted failures were recovered.
    recoveryObserved ||= unseenPending;
    unseenPending = false;
    const completedRunId =
      (message.stopReason === "stop" || message.stopReason === "length") &&
      !isTranscriptOnlyOpenClawAssistantMessage(message)
        ? readSessionTranscriptRunId(message)
        : undefined;
    pendingIndexes = pendingIndexes.filter((pendingIndex) => {
      const failedRunId = readSessionTranscriptRunId(messages[pendingIndex]);
      // Unattributed legacy stream sentinels retain their existing turn-local
      // repair. Runtime attempt failures require completion of the exact run.
      if (failedRunId && failedRunId !== completedRunId) {
        return true;
      }
      repairedIndexes.add(pendingIndex);
      recoveryObserved = true;
      return false;
    });
  }
  return {
    messages:
      repairedIndexes.size > 0
        ? messages.filter((_, index) => !repairedIndexes.has(index))
        : messages,
    pending: unseenPending || pendingIndexes.length > 0,
    recoveryObserved,
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
    const hasDisplayableStructuredContent =
      hasAssistantDisplayableNonTextContent(message) || hasTranscriptMediaFacts(message);
    if (hasDisplayableStructuredContent) {
      changed = true;
      return sanitizeAssistantErrorDisplayMessage(message);
    }
    const sanitized = sanitizeChatHistoryMessage(message, Number.MAX_SAFE_INTEGER)
      .message as Record<string, unknown>;
    if (!shouldDropAssistantHistoryMessage(sanitized) && hasVisibleAssistantReplyText(sanitized)) {
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
  const projectedActivity = messages.map((message) => {
    const activity = readNestedToolActivity(message);
    if (!activity) {
      return message;
    }
    const [call, result] = nestedToolActivityContent(activity);
    const sanitized = sanitizeChatHistoryMessage(
      { ...result, role: "toolResult" },
      options?.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
    ).message;
    return {
      ...asOptionalRecord(message),
      runId: activity.details.runId,
      // The entry dedupe key identifies a nested call, not its owning run.
      // Publish validated ownership where history and live clients read it.
      __openclaw: {
        ...asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]),
        runId: activity.details.runId,
      },
      content: [call, sanitized],
    };
  });
  const source =
    options?.stripEnvelope === false
      ? projectedActivity
      : stripEnvelopeFromMessages(projectedActivity);
  const mirrored = mirrorMessageToolVisibleReplies(source);
  const recoveredErrors = projectRecoveredAssistantErrors(
    toProjectedMessages(mirrored),
    options?.assistantErrorPending,
  );
  const projectedErrors = projectEmptyAssistantErrorMessages(recoveredErrors.messages);
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
    assistantErrorPending: recoveredErrors.pending,
    assistantErrorRecoveryObserved: recoveredErrors.recoveryObserved,
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
