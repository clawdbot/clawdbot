import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { formatErrorMessage } from "../../infra/errors.js";
import { log } from "./logger.js";

type AssistantContentBlock = Extract<AgentMessage, { role: "assistant" }>["content"][number];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type RecoveryAssessment = "valid" | "incomplete-thinking" | "incomplete-text";
type RecoverySessionMeta = { id: string; recoveredAnthropicThinking?: boolean };

const THINKING_BLOCK_ERROR_PATTERN = /thinking or redacted_thinking blocks?.* cannot be modified/i;
export const OMITTED_ASSISTANT_REASONING_TEXT = "[assistant reasoning omitted]";

export function isAssistantMessageWithContent(message: AgentMessage): message is AssistantMessage {
  return (
    !!message &&
    typeof message === "object" &&
    message.role === "assistant" &&
    Array.isArray(message.content)
  );
}

function isThinkingBlock(block: AssistantContentBlock): boolean {
  return (
    !!block &&
    typeof block === "object" &&
    ((block as { type?: unknown }).type === "thinking" ||
      (block as { type?: unknown }).type === "redacted_thinking")
  );
}

function isToolCallBlock(block: AssistantContentBlock): boolean {
  if (!block || typeof block !== "object") {
    return false;
  }
  const type = (block as { type?: unknown }).type;
  return type === "toolCall" || type === "tool_use" || type === "function_call";
}

function hasAssistantToolCall(message: AssistantMessage): boolean {
  return message.content.some((block) => isToolCallBlock(block));
}

function isToolResultMessage(message: AgentMessage): boolean {
  return (
    !!message &&
    typeof message === "object" &&
    (message as { role?: unknown }).role === "toolResult"
  );
}

function isSignedThinkingBlock(block: AssistantContentBlock): boolean {
  if (!isThinkingBlock(block)) {
    return false;
  }
  const record = block as {
    type?: unknown;
    signature?: unknown;
    thinkingSignature?: unknown;
    thought_signature?: unknown;
  };
  return (
    record.type === "redacted_thinking" ||
    record.signature != null ||
    record.thinkingSignature != null ||
    record.thought_signature != null
  );
}

function hasMeaningfulText(block: AssistantContentBlock): boolean {
  if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "text") {
    return false;
  }
  return typeof (block as { text?: unknown }).text === "string"
    ? (block as { text: string }).text.trim().length > 0
    : false;
}

function buildOmittedAssistantReasoningContent(): AssistantContentBlock[] {
  // Provider converters drop blank text blocks; keep this neutral text non-empty so the assistant turn survives replay.
  return [{ type: "text", text: OMITTED_ASSISTANT_REASONING_TEXT } as AssistantContentBlock];
}

function hasReplayableThinkingSignature(block: AssistantContentBlock): boolean {
  if (!isThinkingBlock(block)) {
    return false;
  }
  const record = block as {
    data?: unknown;
    signature?: unknown;
    thinkingSignature?: unknown;
    thought_signature?: unknown;
  };
  const candidates =
    (block as { type?: unknown }).type === "redacted_thinking"
      ? [record.data, record.signature, record.thinkingSignature, record.thought_signature]
      : [record.signature, record.thinkingSignature, record.thought_signature];
  return candidates.some((signature) => {
    return typeof signature === "string" && signature.trim().length > 0;
  });
}

/**
 * Strip thinking blocks with clearly invalid replay signatures.
 *
 * Anthropic and Bedrock reject persisted thinking blocks when the signature is
 * absent, empty, or blank. They are also the authority for opaque signature
 * validity, so this intentionally avoids local length or shape heuristics.
 */
export function stripInvalidThinkingSignatures(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];

  for (const message of messages) {
    if (!isAssistantMessageWithContent(message)) {
      out.push(message);
      continue;
    }

    const nextContent: AssistantContentBlock[] = [];
    let changed = false;
    for (const block of message.content) {
      if (!isThinkingBlock(block) || hasReplayableThinkingSignature(block)) {
        nextContent.push(block);
        continue;
      }
      changed = true;
      touched = true;
    }

    if (!changed) {
      out.push(message);
      continue;
    }

    out.push({
      ...message,
      content: nextContent.length > 0 ? nextContent : buildOmittedAssistantReasoningContent(),
    });
  }

  return touched ? out : messages;
}

/**
 * Strip `type: "thinking"` and `type: "redacted_thinking"` content blocks from
 * all assistant messages except the latest one.
 *
 * Thinking blocks in the latest assistant turn are preserved verbatim so
 * providers that require replay signatures can continue the conversation.
 *
 * If a non-latest assistant message becomes empty after stripping, it is
 * replaced with a synthetic non-empty text block to preserve turn structure
 * through provider adapters that filter blank text blocks.
 *
 * Returns the original array reference when nothing was changed (callers can
 * use reference equality to skip downstream work).
 */
export function dropThinkingBlocks(messages: AgentMessage[]): AgentMessage[] {
  let latestAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isAssistantMessageWithContent(messages[i])) {
      latestAssistantIndex = i;
      break;
    }
  }

  let touched = false;
  const out: AgentMessage[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!isAssistantMessageWithContent(msg)) {
      out.push(msg);
      continue;
    }
    if (i === latestAssistantIndex) {
      out.push(msg);
      continue;
    }
    const nextContent: AssistantContentBlock[] = [];
    let changed = false;
    for (const block of msg.content) {
      if (isThinkingBlock(block)) {
        touched = true;
        changed = true;
        continue;
      }
      nextContent.push(block);
    }
    if (!changed) {
      out.push(msg);
      continue;
    }
    const content = nextContent.length > 0 ? nextContent : buildOmittedAssistantReasoningContent();
    out.push({ ...msg, content });
  }
  return touched ? out : messages;
}

function shouldPreserveCurrentToolTurnReasoning(
  messages: AgentMessage[],
  index: number,
  latestUserIndex: number,
): boolean {
  const message = messages[index];
  if (
    index < latestUserIndex ||
    !isAssistantMessageWithContent(message) ||
    !hasAssistantToolCall(message)
  ) {
    return false;
  }

  for (let i = index - 1; i >= 0; i -= 1) {
    const role = (messages[i] as { role?: unknown })?.role;
    if (role === "user") {
      break;
    }
    if (role === "assistant") {
      return false;
    }
  }

  for (let i = index + 1; i < messages.length; i += 1) {
    const next = messages[i];
    const role = (next as { role?: unknown })?.role;
    if (isToolResultMessage(next)) {
      return true;
    }
    if (role === "user") {
      return false;
    }
  }

  return false;
}

function stripAllThinkingBlocks(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];
  for (const message of messages) {
    if (!isAssistantMessageWithContent(message)) {
      out.push(message);
      continue;
    }

    const nextContent = message.content.filter((block) => !isThinkingBlock(block));
    if (nextContent.length === message.content.length) {
      out.push(message);
      continue;
    }

    touched = true;
    out.push({
      ...message,
      content: nextContent.length > 0 ? nextContent : buildOmittedAssistantReasoningContent(),
    });
  }
  return touched ? out : messages;
}

export function dropReasoningFromHistory(messages: AgentMessage[]): AgentMessage[] {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if ((messages[index] as { role?: unknown })?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }

  let touched = false;
  const out: AgentMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!isAssistantMessageWithContent(message)) {
      out.push(message);
      continue;
    }
    if (shouldPreserveCurrentToolTurnReasoning(messages, index, latestUserIndex)) {
      out.push(message);
      continue;
    }

    const nextContent = message.content.filter((block) => !isThinkingBlock(block));
    if (nextContent.length === message.content.length) {
      out.push(message);
      continue;
    }

    touched = true;
    out.push({
      ...message,
      content: nextContent.length > 0 ? nextContent : buildOmittedAssistantReasoningContent(),
    });
  }
  return touched ? out : messages;
}

export function assessLastAssistantMessage(message: AgentMessage): RecoveryAssessment {
  if (!isAssistantMessageWithContent(message)) {
    return "valid";
  }
  if (message.content.length === 0) {
    return "incomplete-thinking";
  }

  let hasSignedThinking = false;
  let hasUnsignedThinking = false;
  let hasNonThinkingContent = false;
  let hasEmptyTextBlock = false;

  for (const block of message.content) {
    if (!block || typeof block !== "object") {
      return "incomplete-thinking";
    }
    if (isThinkingBlock(block)) {
      if (isSignedThinkingBlock(block)) {
        hasSignedThinking = true;
      } else {
        hasUnsignedThinking = true;
      }
      continue;
    }
    hasNonThinkingContent = true;
    if ((block as { type?: unknown }).type === "text" && !hasMeaningfulText(block)) {
      hasEmptyTextBlock = true;
    }
  }

  if (hasUnsignedThinking) {
    return "incomplete-thinking";
  }
  if (hasSignedThinking && !hasNonThinkingContent) {
    return "incomplete-text";
  }
  if (hasSignedThinking && hasEmptyTextBlock) {
    return "incomplete-text";
  }
  return "valid";
}

export function sanitizeThinkingForRecovery(messages: AgentMessage[]): {
  messages: AgentMessage[];
  prefill: boolean;
} {
  if (messages.length === 0) {
    return { messages, prefill: false };
  }

  let lastAssistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if ((messages[index] as { role?: unknown }).role === "assistant") {
      lastAssistantIndex = index;
      break;
    }
  }
  if (lastAssistantIndex === -1) {
    return { messages, prefill: false };
  }

  const assessment = assessLastAssistantMessage(messages[lastAssistantIndex]);
  if (assessment === "valid") {
    return { messages, prefill: false };
  }
  if (assessment === "incomplete-text") {
    return { messages, prefill: true };
  }

  return {
    messages: [...messages.slice(0, lastAssistantIndex), ...messages.slice(lastAssistantIndex + 1)],
    prefill: false,
  };
}

function shouldRecoverAnthropicThinkingError(
  error: unknown,
  sessionMeta: RecoverySessionMeta,
): boolean {
  const message = formatErrorMessage(error);
  if (!THINKING_BLOCK_ERROR_PATTERN.test(message)) {
    return false;
  }
  if (sessionMeta.recoveredAnthropicThinking) {
    log.warn(
      `[session-recovery] Anthropic thinking recovery already attempted: sessionId=${sessionMeta.id}`,
    );
    return false;
  }
  return true;
}

async function pumpStreamWithRecovery(
  outer: ReturnType<typeof createAssistantMessageEventStream>,
  stream: ReturnType<StreamFn>,
  sessionMeta: RecoverySessionMeta,
  retry: () => ReturnType<StreamFn>,
): Promise<AssistantMessage> {
  let yieldedChunk = false;
  try {
    const resolved = stream instanceof Promise ? await stream : stream;
    for await (const chunk of resolved as AsyncIterable<unknown>) {
      yieldedChunk = true;
      outer.push(chunk as Parameters<typeof outer.push>[0]);
    }
    const result = await (resolved as { result?: () => Promise<AssistantMessage> }).result?.();
    return result as AssistantMessage;
  } catch (error: unknown) {
    if (!shouldRecoverAnthropicThinkingError(error, sessionMeta)) {
      throw error;
    }
    if (yieldedChunk) {
      log.warn(
        `[session-recovery] Anthropic thinking error occurred after streaming began; skipping retry to avoid duplicate chunks: sessionId=${sessionMeta.id}`,
      );
      throw error;
    }
    sessionMeta.recoveredAnthropicThinking = true;
    log.warn(
      `[session-recovery] Anthropic thinking error during stream; retrying once without thinking blocks: sessionId=${sessionMeta.id}`,
    );
    const retryStream = retry();
    const resolvedRetry = retryStream instanceof Promise ? await retryStream : retryStream;
    for await (const chunk of resolvedRetry as AsyncIterable<unknown>) {
      outer.push(chunk as Parameters<typeof outer.push>[0]);
    }
    const result = await (resolvedRetry as { result?: () => Promise<AssistantMessage> }).result?.();
    return result as AssistantMessage;
  }
}

export function wrapAnthropicStreamWithRecovery(
  innerStreamFn: StreamFn,
  sessionMeta: RecoverySessionMeta,
): StreamFn {
  return (model, context, options) => {
    const contextRecord = context as unknown as { messages?: unknown };
    const originalMessages = Array.isArray(contextRecord.messages)
      ? (contextRecord.messages as AgentMessage[])
      : [];
    const retry = () => {
      const cleanedMessages = stripAllThinkingBlocks(originalMessages);
      const nextContext = {
        ...(context as unknown as Record<string, unknown>),
        messages: cleanedMessages,
      } as typeof context;
      return innerStreamFn(model, nextContext, options);
    };

    const stream = innerStreamFn(model, context, options);
    if (stream instanceof Promise) {
      return stream.catch((error: unknown) => {
        if (!shouldRecoverAnthropicThinkingError(error, sessionMeta)) {
          throw error;
        }
        sessionMeta.recoveredAnthropicThinking = true;
        log.warn(
          `[session-recovery] Anthropic thinking request rejected; retrying once without thinking blocks: sessionId=${sessionMeta.id}`,
        );
        return retry();
      }) as ReturnType<StreamFn>;
    }
    const outer = createAssistantMessageEventStream();
    const finalResultPromise = pumpStreamWithRecovery(outer, stream, sessionMeta, retry).finally(
      () => {
        outer.end();
      },
    );
    outer.result = () => finalResultPromise;
    return outer as unknown as ReturnType<StreamFn>;
  };
}
