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
