type AssistantTurnLike = {
  role?: unknown;
  stopReason?: unknown;
  content?: unknown;
};

/** Returns true when an assistant turn contains only provider reasoning and blank text. */
export function hasOnlyAssistantReasoningContent(message: AssistantTurnLike): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const content = Array.isArray(message.content)
    ? message.content
    : message.content != null && typeof message.content === "object"
      ? [message.content]
      : [];
  let hasThinking = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      return false;
    }
    if (!("type" in block)) {
      return false;
    }
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      hasThinking = true;
      continue;
    }
    if (
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string" &&
      !block.text.trim()
    ) {
      continue;
    }
    return false;
  }
  return hasThinking;
}

/** Returns true when a token-limited turn contains only incomplete provider reasoning. */
export function isReasoningOnlyLengthAssistantTurn(message: AssistantTurnLike): boolean {
  return message.stopReason === "length" && hasOnlyAssistantReasoningContent(message);
}

/**
 * Stands in for a failed assistant turn during replay. Keeps the turn present so the
 * user message before it is not mistaken for a new request, without replaying partial
 * output the provider never finished.
 */
export const FAILED_ASSISTANT_REPLAY_TEXT =
  "[This turn failed before it completed. Do not redo its work without confirming with the user first.]";

/** Returns true when an assistant turn ended without completing its answer. */
export function isFailedAssistantTurn(message: AssistantTurnLike): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  return (
    message.stopReason === "error" ||
    message.stopReason === "aborted" ||
    isReasoningOnlyLengthAssistantTurn(message)
  );
}

/** Returns true when a failed turn still carries tool calls that need pairing repair. */
export function failedAssistantHasToolCalls(message: AssistantTurnLike): boolean {
  return (
    message.role === "assistant" &&
    (message.stopReason === "error" || message.stopReason === "aborted") &&
    Array.isArray(message.content) &&
    message.content.some(
      (block) =>
        typeof block === "object" && block !== null && "type" in block && block.type === "toolCall",
    )
  );
}

/**
 * How a failed assistant turn should appear in replay. Dropping it outright leaves the
 * preceding user message looking unanswered, so the model merges it with the next
 * request and can redo work the turn already completed.
 */
export type FailedAssistantReplay = "keep" | "drop" | "marker";

/**
 * Shared replay policy for both the host transport transform and the provider-owned
 * converter, so a failed turn is treated the same way whichever boundary replays it.
 * `pairingAware` callers can repair tool-call frames themselves and keep the original.
 */
export function resolveFailedAssistantReplay(
  message: AssistantTurnLike,
  options: { pairingAware: boolean },
): FailedAssistantReplay {
  if (!isFailedAssistantTurn(message)) {
    return "keep";
  }
  if (failedAssistantHasToolCalls(message)) {
    // Pairing-aware transports must see errored tool-call frames and their adjacent
    // results together; pre-filtering the call can misattribute its result to an older
    // turn that reused the same provider id.
    return options.pairingAware ? "keep" : "drop";
  }
  if (isReasoningOnlyLengthAssistantTurn(message)) {
    // Thinking-only length stops carry provider-owned signatures and no answer text,
    // so they stay dropped rather than replaying an unusable reasoning block.
    return "drop";
  }
  return "marker";
}
