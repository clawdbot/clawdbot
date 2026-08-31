import {
  WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
  type WorkerInferenceContext,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";

export type WorkerReplayMessageWindowUnavailable = {
  reason: "provider-replay-message-limit";
  messageCount: number;
  limitMessages: number;
};

type WorkerReplayMessageWindow<T> =
  | { kind: "complete"; messages: T[] }
  | { kind: "provider-replay-unavailable"; details: WorkerReplayMessageWindowUnavailable };

type ReplayWindowMessage = { role: string; providerReplay?: unknown };

export function windowWorkerReplayMessages<T extends ReplayWindowMessage>(
  messages: T[],
  limitMessages: number,
): WorkerReplayMessageWindow<T> {
  if (messages.length <= limitMessages) {
    return { kind: "complete", messages };
  }
  const minimumStart = messages.length - limitMessages;
  // Replay owner plus suffix is one authoritative unit. Starting after the
  // owner leaves a context-blind suffix, so fail instead of trimming through it.
  const replayIndex = messages.findLastIndex((message) => message.providerReplay !== undefined);
  if (replayIndex >= 0 && messages.length - replayIndex > limitMessages) {
    return {
      kind: "provider-replay-unavailable",
      details: {
        reason: "provider-replay-message-limit",
        messageCount: messages.length - replayIndex,
        limitMessages,
      },
    };
  }
  const completeTurnStart = messages.findIndex(
    (message, index) => index >= minimumStart && message.role === "user",
  );
  const start =
    replayIndex >= 0 && (completeTurnStart < 0 || completeTurnStart > replayIndex)
      ? replayIndex
      : completeTurnStart;
  if (start < 0) {
    throw new Error("Worker context has no complete user turn within the message limit.");
  }
  return { kind: "complete", messages: messages.slice(start) };
}

type ReplayImageMessage = WorkerInferenceContext["messages"][number];
const PROCESSED_IMAGE_MARKER = {
  type: "text" as const,
  text: "[image data removed - already processed by model]",
};

/** Fit only the model projection; persisted images and replay checkpoints stay untouched. */
export function fitWorkerReplayImages<T extends ReplayImageMessage>(
  messages: T[],
  measureBytes: (messages: T[]) => number,
  protectedToolCallId?: string,
): T[] | undefined {
  if (measureBytes(messages) <= WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES) {
    return messages;
  }
  // Checkpoints can replay retained user images or require full-history recovery.
  // Only the provider owner can authorize changes to that opaque replay unit.
  if (
    messages.some((message) => message.role === "assistant" && message.providerReplay !== undefined)
  ) {
    return undefined;
  }
  const observedBefore = messages.findLastIndex(
    (message) =>
      message.role === "assistant" &&
      message.stopReason !== "error" &&
      message.stopReason !== "aborted",
  );
  const latestImage = messages.findLastIndex(
    (message) =>
      message.role !== "assistant" &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "image"),
  );
  let fitted = messages;
  for (let index = 0; index < observedBefore; index++) {
    const message = messages[index]!;
    if (
      index === latestImage ||
      message.role === "assistant" ||
      !Array.isArray(message.content) ||
      (message.role === "toolResult" && message.toolCallId === protectedToolCallId)
    ) {
      continue;
    }
    let content = message.content;
    for (const [blockIndex, block] of message.content.entries()) {
      if (block.type !== "image") {
        continue;
      }
      if (fitted === messages) {
        fitted = messages.slice();
      }
      if (content === message.content) {
        content = message.content.slice();
      }
      content[blockIndex] = PROCESSED_IMAGE_MARKER;
      fitted[index] = Object.assign({}, message, { content });
      // The transport may escape nested JSON; plain image-block byte savings
      // cannot decide whether this candidate fits or needs another image removed.
      if (measureBytes(fitted) <= WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES) {
        return fitted;
      }
    }
  }
  return undefined;
}
