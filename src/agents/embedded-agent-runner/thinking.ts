/**
 * Sanitizes reasoning/thinking blocks for replay and recovery.
 */
import { collectErrorGraphCandidates, formatErrorMessage } from "../../infra/errors.js";
import type { AssistantMessageEvent } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import type { AgentMessage, StreamFn } from "../runtime/index.js";
import { log } from "./logger.js";

type AssistantContentBlock = Extract<AgentMessage, { role: "assistant" }>["content"][number];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type RecoveryAssessment = "valid" | "incomplete-thinking" | "incomplete-text";
type AnthropicThinkingRecovery = {
  originalMessages: AgentMessage[];
  cleanedMessages: AgentMessage[];
};
type RecoverySessionMeta = {
  id: string;
  recoveredAnthropicThinking?: boolean;
  onRecoveredAnthropicThinking?: (recovery: AnthropicThinkingRecovery) => void | Promise<void>;
};

const THINKING_BLOCK_ERROR_PATTERN =
  /(?:thinking|redacted_thinking).*?(?:cannot be modified|signature|invalid|missing|empty|blank)|(?:signature|invalid|missing|empty|blank).*?(?:thinking|redacted_thinking)/i;
const OMITTED_ASSISTANT_REASONING_TEXT = "[assistant reasoning omitted]";

function isAssistantMessageWithContent(message: AgentMessage): message is AssistantMessage {
  return (
    Boolean(message) &&
    typeof message === "object" &&
    message.role === "assistant" &&
    Array.isArray(message.content)
  );
}

function isThinkingBlock(block: AssistantContentBlock): boolean {
  return (
    Boolean(block) &&
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
    Boolean(message) &&
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

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function stripSignatureFieldsFromThinkingBlock(
  block: AssistantContentBlock,
): AssistantContentBlock {
  const record = block as unknown as Record<string, unknown>;
  const stripped: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key === "thinkingSignature" || key === "signature" || key === "thought_signature") {
      continue;
    }
    // data is the signature payload for redacted_thinking blocks
    if (key === "data" && record.type === "redacted_thinking") {
      continue;
    }
    stripped[key] = record[key];
  }
  return stripped as unknown as AssistantContentBlock;
}

/**
 * Strip all thinking signature fields from a single assistant message.
 *
 * Removes thinkingSignature / signature / thought_signature from thinking blocks and
 * data from redacted_thinking blocks. Thinking text is preserved. If the message
 * becomes thinking-only with no signatures, the downstream stripInvalidThinkingSignatures
 * will convert those unsigned blocks to placeholder text.
 *
 * Returns the original reference when nothing was stripped.
 */
export function stripThinkingSignaturesFromMessage(message: AgentMessage): AgentMessage {
  if (!isAssistantMessageWithContent(message)) {
    return message;
  }
  let changed = false;
  const newContent: AssistantContentBlock[] = [];
  for (const block of message.content) {
    if (!isThinkingBlock(block)) {
      newContent.push(block);
      continue;
    }
    const record = block as unknown as Record<string, unknown>;
    const hasSignature =
      record.thinkingSignature != null ||
      record.signature != null ||
      record.thought_signature != null ||
      (record.type === "redacted_thinking" && record.data != null);
    if (!hasSignature) {
      newContent.push(block);
      continue;
    }
    newContent.push(stripSignatureFieldsFromThinkingBlock(block));
    changed = true;
  }
  if (!changed) {
    return message;
  }
  return { ...message, content: newContent };
}

/**
 * Strip thinking signatures from assistant messages that predate the latest compaction.
 *
 * Pre-compaction thinking signatures are cryptographically bound to the original context
 * prefix. After compaction the prefix changes (summarized content is replaced by the
 * compaction summary) so those signatures are stale and Anthropic rejects them with
 * "Invalid signature in thinking block". The existing stripInvalidThinkingSignatures only
 * catches absent/blank signatures; this function catches contextually stale ones identified
 * by timestamp comparison with the latest compaction summary.
 *
 * Only strips from assistant messages whose timestamp is strictly before the latest
 * compaction summary timestamp. Messages at or after that timestamp may have been generated
 * in the new context and retain their signatures. Messages with no parseable timestamp are
 * left unchanged.
 *
 * Returns the original array reference when nothing was changed.
 */
export function stripStaleThinkingSignaturesForCompactionReplay(
  messages: AgentMessage[],
): AgentMessage[] {
  let latestCompactionTimestamp: number | null = null;
  for (const message of messages) {
    if ((message as { role?: unknown }).role !== "compactionSummary") {
      continue;
    }
    const ts = parseTimestampMs((message as { timestamp?: unknown }).timestamp);
    if (ts !== null) {
      latestCompactionTimestamp =
        latestCompactionTimestamp === null ? ts : Math.max(latestCompactionTimestamp, ts);
    }
  }
  if (latestCompactionTimestamp === null) {
    return messages;
  }

  let touched = false;
  const out: AgentMessage[] = [];
  for (const message of messages) {
    if (!isAssistantMessageWithContent(message)) {
      out.push(message);
      continue;
    }
    const ts = parseTimestampMs((message as { timestamp?: unknown }).timestamp);
    if (ts === null || ts >= latestCompactionTimestamp) {
      out.push(message);
      continue;
    }
    const stripped = stripThinkingSignaturesFromMessage(message);
    if (stripped !== message) {
      touched = true;
    }
    out.push(stripped);
  }
  return touched ? out : messages;
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
 *
 * By default, the latest assistant turn is exempt: providers reject modified
 * latest thinking blocks, so corrupted latest turns must flow through recovery
 * rather than being rewritten before the request. Callers that append a new
 * user turn before provider replay can disable that exemption because the
 * stored assistant turn is no longer latest in the outbound request.
 */
export function stripInvalidThinkingSignatures(
  messages: AgentMessage[],
  options: { preserveLatestAssistant?: boolean } = {},
): AgentMessage[] {
  const preserveLatestAssistant = options.preserveLatestAssistant ?? true;
  let latestAssistantIndex = -1;
  if (preserveLatestAssistant) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages.at(i);
      if (message && isAssistantMessageWithContent(message)) {
        latestAssistantIndex = i;
        break;
      }
    }
  }

  let touched = false;
  const out: AgentMessage[] = [];

  for (const [i, message] of messages.entries()) {
    if (!isAssistantMessageWithContent(message)) {
      out.push(message);
      continue;
    }
    if (i === latestAssistantIndex) {
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
    const message = messages.at(i);
    if (message && isAssistantMessageWithContent(message)) {
      latestAssistantIndex = i;
      break;
    }
  }

  let touched = false;
  const out: AgentMessage[] = [];
  for (const [i, msg] of messages.entries()) {
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
  const message = messages.at(index);
  if (
    !message ||
    index < latestUserIndex ||
    !isAssistantMessageWithContent(message) ||
    !hasAssistantToolCall(message)
  ) {
    return false;
  }

  for (let i = index - 1; i >= 0; i -= 1) {
    const role = messages.at(i)?.role;
    if (role === "user") {
      break;
    }
    if (role === "assistant") {
      return false;
    }
  }

  for (let i = index + 1; i < messages.length; i += 1) {
    const next = messages.at(i);
    const role = next?.role;
    if (next && isToolResultMessage(next)) {
      return true;
    }
    if (role === "user") {
      return false;
    }
  }

  return false;
}

export function shouldPreserveLatestAssistantThinking(messages: AgentMessage[]): boolean {
  let latestAssistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages.at(index);
    if (message && isAssistantMessageWithContent(message)) {
      latestAssistantIndex = index;
      break;
    }
  }
  if (latestAssistantIndex < 0) {
    return false;
  }
  if (latestAssistantIndex === messages.length - 1) {
    return true;
  }

  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages.at(index)?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  return shouldPreserveCurrentToolTurnReasoning(messages, latestAssistantIndex, latestUserIndex);
}

export function stripThinkingBlocksFromMessage(message: AgentMessage): AgentMessage {
  if (!isAssistantMessageWithContent(message)) {
    return message;
  }
  const nextContent = message.content.filter((block) => !isThinkingBlock(block));
  if (nextContent.length === message.content.length) {
    return message;
  }
  return {
    ...message,
    content: nextContent.length > 0 ? nextContent : buildOmittedAssistantReasoningContent(),
  };
}

function stripAllThinkingBlocks(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];
  for (const message of messages) {
    const stripped = stripThinkingBlocksFromMessage(message);
    if (stripped === message) {
      out.push(stripped);
      continue;
    }
    touched = true;
    out.push(stripped);
  }
  return touched ? out : messages;
}

export function dropReasoningFromHistory(messages: AgentMessage[]): AgentMessage[] {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages.at(index)?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }

  let touched = false;
  const out: AgentMessage[] = [];
  for (const [index, message] of messages.entries()) {
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

function shouldRecoverAnthropicThinkingError(
  error: unknown,
  sessionMeta: RecoverySessionMeta,
): boolean {
  // Provider detail survives genericization in different carriers across the
  // Anthropic SDK, failover wrapping, and terminal stream messages.
  const candidates = collectErrorGraphCandidates(error, (current) => [
    current.cause,
    current.error,
    current.rawError,
    current.errorMessage,
    current.errorBody,
    current.message,
  ]);
  for (const candidate of candidates) {
    if (
      typeof candidate === "string" &&
      shouldRecoverAnthropicThinkingErrorMessage(candidate, sessionMeta)
    ) {
      return true;
    }
  }
  return false;
}

function shouldRecoverAnthropicThinkingErrorMessage(
  message: string,
  sessionMeta: RecoverySessionMeta,
): boolean {
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

function isAssistantMessageErrorEvent(
  event: unknown,
): event is Extract<AssistantMessageEvent, { type: "error" }> {
  return (
    Boolean(event) && typeof event === "object" && (event as { type?: unknown }).type === "error"
  );
}

async function notifyRecoveredAnthropicThinking(
  sessionMeta: RecoverySessionMeta,
  recovery: AnthropicThinkingRecovery,
): Promise<void> {
  try {
    await sessionMeta.onRecoveredAnthropicThinking?.(recovery);
  } catch (error: unknown) {
    log.warn(
      `[session-recovery] Anthropic thinking transcript repair hook failed: sessionId=${sessionMeta.id} error=${formatErrorMessage(error)}`,
    );
  }
}

function isSuccessfulRecoveryRetryResult(message: AssistantMessage | undefined): boolean {
  if (!message) {
    return false;
  }
  return message.stopReason !== "error" && message.stopReason !== "aborted";
}

function wrapRetryStreamWithRecoveryNotification(
  retryStream: ReturnType<StreamFn>,
  notify: () => Promise<void>,
): ReturnType<StreamFn> {
  if (retryStream instanceof Promise) {
    return retryStream.then((resolved) =>
      wrapRetryStreamWithRecoveryNotification(resolved as ReturnType<StreamFn>, notify),
    ) as ReturnType<StreamFn>;
  }
  const streamWithResult = retryStream as unknown as {
    result?: () => Promise<AssistantMessage>;
  };
  if (typeof streamWithResult.result !== "function") {
    return retryStream;
  }
  const result = streamWithResult.result.bind(streamWithResult);
  let notified = false;
  streamWithResult.result = async () => {
    const message = await result();
    if (!notified && isSuccessfulRecoveryRetryResult(message)) {
      notified = true;
      await notify();
    }
    return message;
  };
  return retryStream;
}

async function retryStreamWithoutThinking(
  outer: ReturnType<typeof createAssistantMessageEventStream>,
  retry: () => ReturnType<StreamFn>,
  notify: () => Promise<void>,
): Promise<AssistantMessage> {
  const retryStream = retry();
  const resolvedRetry = retryStream instanceof Promise ? await retryStream : retryStream;
  for await (const chunk of resolvedRetry as AsyncIterable<unknown>) {
    outer.push(chunk as Parameters<typeof outer.push>[0]);
  }
  const result = await (resolvedRetry as { result?: () => Promise<AssistantMessage> }).result?.();
  if (isSuccessfulRecoveryRetryResult(result)) {
    await notify();
  }
  return result as AssistantMessage;
}

async function pumpStreamWithRecovery(
  outer: ReturnType<typeof createAssistantMessageEventStream>,
  stream: ReturnType<StreamFn>,
  sessionMeta: RecoverySessionMeta,
  retry: () => ReturnType<StreamFn>,
  notify: () => Promise<void>,
): Promise<AssistantMessage> {
  let yieldedOutput = false;
  try {
    const resolved = stream instanceof Promise ? await stream : stream;
    for await (const chunk of resolved as AsyncIterable<unknown>) {
      if (isAssistantMessageErrorEvent(chunk)) {
        if (shouldRecoverAnthropicThinkingError(chunk.error, sessionMeta)) {
          if (yieldedOutput) {
            log.warn(
              `[session-recovery] Anthropic thinking error occurred after streaming began; skipping retry to avoid duplicate chunks: sessionId=${sessionMeta.id}`,
            );
          } else {
            sessionMeta.recoveredAnthropicThinking = true;
            log.warn(
              `[session-recovery] Anthropic thinking stream error; retrying once without thinking blocks: sessionId=${sessionMeta.id}`,
            );
            return retryStreamWithoutThinking(outer, retry, notify);
          }
        }
      } else {
        yieldedOutput = true;
      }
      outer.push(chunk as Parameters<typeof outer.push>[0]);
    }
    const result = await (resolved as { result?: () => Promise<AssistantMessage> }).result?.();
    return result as AssistantMessage;
  } catch (error: unknown) {
    if (!shouldRecoverAnthropicThinkingError(error, sessionMeta)) {
      throw error;
    }
    if (yieldedOutput) {
      log.warn(
        `[session-recovery] Anthropic thinking error occurred after streaming began; skipping retry to avoid duplicate chunks: sessionId=${sessionMeta.id}`,
      );
      throw error;
    }
    sessionMeta.recoveredAnthropicThinking = true;
    log.warn(
      `[session-recovery] Anthropic thinking error during stream; retrying once without thinking blocks: sessionId=${sessionMeta.id}`,
    );
    return retryStreamWithoutThinking(outer, retry, notify);
  }
}

function createRecoveryStream(
  stream: Awaited<ReturnType<StreamFn>>,
  sessionMeta: RecoverySessionMeta,
  retry: () => ReturnType<StreamFn>,
  notify: () => Promise<void>,
): Awaited<ReturnType<StreamFn>> {
  const outer = createAssistantMessageEventStream();
  const finalResultPromise = pumpStreamWithRecovery(
    outer,
    stream,
    sessionMeta,
    retry,
    notify,
  ).finally(() => {
    outer.end();
  });
  outer.result = () => finalResultPromise;
  return outer;
}

export function wrapAnthropicStreamWithRecovery(
  innerStreamFn: StreamFn,
  sessionMeta: RecoverySessionMeta,
): StreamFn {
  return (model, context, options) => {
    const requestMeta: RecoverySessionMeta = {
      id: sessionMeta.id,
      onRecoveredAnthropicThinking: sessionMeta.onRecoveredAnthropicThinking,
    };
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
    const notify = () =>
      notifyRecoveredAnthropicThinking(requestMeta, {
        originalMessages,
        cleanedMessages: stripAllThinkingBlocks(originalMessages),
      });

    const stream = innerStreamFn(model, context, options);
    if (stream instanceof Promise) {
      return stream.then(
        (resolved) => createRecoveryStream(resolved, requestMeta, retry, notify),
        (error: unknown) => {
          if (!shouldRecoverAnthropicThinkingError(error, requestMeta)) {
            throw error;
          }
          requestMeta.recoveredAnthropicThinking = true;
          log.warn(
            `[session-recovery] Anthropic thinking request rejected; retrying once without thinking blocks: sessionId=${requestMeta.id}`,
          );
          return wrapRetryStreamWithRecoveryNotification(retry(), notify);
        },
      ) as ReturnType<StreamFn>;
    }
    return createRecoveryStream(stream, requestMeta, retry, notify);
  };
}
