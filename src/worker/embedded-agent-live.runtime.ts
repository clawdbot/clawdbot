import type { WorkerLiveEvent } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { AgentMessage } from "../agents/runtime/index.js";
import type { AgentSessionEvent } from "../agents/sessions/agent-session.js";
import type { AssistantMessage } from "../llm/types.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";

const MAX_LIVE_EVENT_BYTES = 32 * 1024;
const MAX_LIVE_PREVIEW_BYTES = 4 * 1024;

function liveEventBytes(event: WorkerLiveEvent): number {
  try {
    return Buffer.byteLength(JSON.stringify(event), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function truncateLiveText(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_LIVE_PREVIEW_BYTES) {
    return value;
  }
  const suffix = "…";
  return `${truncateUtf8Prefix(
    value,
    MAX_LIVE_PREVIEW_BYTES - Buffer.byteLength(suffix, "utf8"),
  )}${suffix}`;
}

function boundLiveValue(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      return null;
    }
    if (Buffer.byteLength(serialized, "utf8") <= MAX_LIVE_PREVIEW_BYTES) {
      return structuredClone(value);
    }
    return { truncated: true, preview: truncateLiveText(serialized) };
  } catch {
    return { truncated: true, preview: "[unserializable live payload]" };
  }
}

function boundLiveEvent(event: WorkerLiveEvent): WorkerLiveEvent {
  if (liveEventBytes(event) <= MAX_LIVE_EVENT_BYTES) {
    return structuredClone(event);
  }
  let bounded: WorkerLiveEvent;
  if (event.kind === "assistant") {
    const text = truncateLiveText(event.payload.text);
    bounded = {
      kind: "assistant",
      payload: {
        ...event.payload,
        text,
        delta: text,
        replace: true,
      },
    };
  } else if (event.kind === "thinking") {
    bounded = {
      kind: "thinking",
      payload: {
        text: truncateLiveText(event.payload.text),
        delta: truncateLiveText(event.payload.delta),
      },
    };
  } else if (event.kind === "tool") {
    if (event.payload.phase === "start") {
      bounded = {
        kind: "tool",
        payload: { ...event.payload, args: boundLiveValue(event.payload.args) },
      };
    } else if (event.payload.phase === "update") {
      bounded = {
        kind: "tool",
        payload: {
          ...event.payload,
          partialResult: boundLiveValue(event.payload.partialResult),
        },
      };
    } else {
      bounded = {
        kind: "tool",
        payload: { ...event.payload, result: boundLiveValue(event.payload.result) },
      };
    }
  } else if (event.kind === "lifecycle" && event.payload.phase === "error") {
    bounded = {
      kind: "lifecycle",
      payload: { ...event.payload, error: truncateLiveText(event.payload.error) },
    };
  } else {
    throw new Error(`worker live ${event.kind} event exceeds the protocol payload limit`);
  }
  if (liveEventBytes(bounded) > MAX_LIVE_EVENT_BYTES) {
    throw new Error(`worker live ${event.kind} event cannot fit the protocol payload limit`);
  }
  return bounded;
}

function coalescePendingLiveEvent(pending: WorkerLiveEvent[], event: WorkerLiveEvent): boolean {
  const index = pending.length - 1;
  const previous = pending[index];
  if (!previous) {
    return false;
  }
  if (previous.kind === "assistant" && event.kind === "assistant") {
    pending[index] = boundLiveEvent({
      kind: "assistant",
      payload: { ...event.payload, delta: event.payload.text, replace: true },
    });
    return true;
  }
  if (previous.kind === "thinking" && event.kind === "thinking") {
    if (event.payload.text === "" && event.payload.delta === "") {
      return false;
    }
    pending[index] = boundLiveEvent({
      kind: "thinking",
      payload: {
        text: event.payload.text,
        delta: `${previous.payload.delta}${event.payload.delta}`,
      },
    });
    return true;
  }
  if (
    previous.kind === "tool" &&
    previous.payload.phase === "update" &&
    event.kind === "tool" &&
    event.payload.phase === "update" &&
    previous.payload.toolCallId === event.payload.toolCallId
  ) {
    pending[index] = boundLiveEvent(event);
    return true;
  }
  return false;
}

function readAssistantText(message: AgentMessage): string {
  if (message.role !== "assistant") {
    return "";
  }
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function readAssistantThinking(message: AgentMessage): string {
  if (message.role !== "assistant") {
    return "";
  }
  return message.content
    .filter((part) => part.type === "thinking")
    .map((part) => part.thinking)
    .join("");
}

type WorkerLiveClient = {
  emit: (event: WorkerLiveEvent) => Promise<void>;
};

type WorkerLiveRuntime = {
  handleSessionEvent: (event: AgentSessionEvent) => void;
  enqueueRunFailure: (failure: { aborted: boolean; error: Error }) => void;
  flush: () => Promise<void>;
  emitTerminal: () => Promise<void>;
};

export function createWorkerLiveRuntime(client: WorkerLiveClient): WorkerLiveRuntime {
  const pendingLiveEvents: WorkerLiveEvent[] = [];
  let liveDrain: Promise<void> | undefined;
  let liveDegraded = false;
  const startLiveDrain = () => {
    if (liveDrain || liveDegraded || pendingLiveEvents.length === 0) {
      return;
    }
    liveDrain = (async () => {
      while (true) {
        const event = pendingLiveEvents.shift();
        if (!event) {
          return;
        }
        await client.emit(event);
      }
    })()
      .catch(() => {
        // Live events are preview-only; transcript commits and inference stay authoritative.
        liveDegraded = true;
        pendingLiveEvents.length = 0;
      })
      .finally(() => {
        liveDrain = undefined;
        startLiveDrain();
      });
  };
  const enqueueLive = (event: WorkerLiveEvent) => {
    if (liveDegraded) {
      return;
    }
    try {
      const bounded = boundLiveEvent(event);
      if (!coalescePendingLiveEvent(pendingLiveEvents, bounded)) {
        pendingLiveEvents.push(bounded);
      }
      startLiveDrain();
    } catch {
      liveDegraded = true;
      pendingLiveEvents.length = 0;
    }
  };
  const flush = async () => {
    let drain = liveDrain;
    while (drain) {
      await drain;
      drain = liveDrain;
    }
  };
  const startedAt = Date.now();
  let lifecycleFinished = false;
  // Terminal lifecycle events are deferred past the final transcript flush so the
  // gateway never sees an end/error before the authoritative transcript commit.
  let terminalLiveEvent: WorkerLiveEvent | undefined;
  let streamedText = "";
  let streamedThinking = "";
  const handleSessionEvent = (event: AgentSessionEvent) => {
    if (event.type === "agent_start") {
      enqueueLive({ kind: "lifecycle", payload: { phase: "start", startedAt } });
      return;
    }
    if (event.type === "message_start" && event.message.role === "assistant") {
      streamedText = "";
      streamedThinking = "";
      return;
    }
    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta") {
        streamedText = readAssistantText(event.message);
        enqueueLive({
          kind: "assistant",
          payload: { text: streamedText, delta: event.assistantMessageEvent.delta },
        });
      } else if (event.assistantMessageEvent.type === "thinking_delta") {
        streamedThinking = readAssistantThinking(event.message);
        enqueueLive({
          kind: "thinking",
          payload: { text: streamedThinking, delta: event.assistantMessageEvent.delta },
        });
      }
      return;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const finalText = readAssistantText(event.message);
      if (finalText !== streamedText) {
        enqueueLive({
          kind: "assistant",
          payload: { text: finalText, delta: finalText, replace: true },
        });
      }
      const finalThinking = readAssistantThinking(event.message);
      if (finalThinking !== streamedThinking) {
        enqueueLive({
          kind: "thinking",
          payload: { text: finalThinking, delta: finalThinking },
        });
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      enqueueLive({
        kind: "tool",
        payload: {
          phase: "start",
          name: event.toolName,
          toolCallId: event.toolCallId,
          args: event.args,
          ...(event.hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
        },
      });
      return;
    }
    if (event.type === "tool_execution_update") {
      enqueueLive({
        kind: "tool",
        payload: {
          phase: "update",
          name: event.toolName,
          toolCallId: event.toolCallId,
          partialResult: event.partialResult,
          ...(event.hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
        },
      });
      return;
    }
    if (event.type === "tool_execution_end") {
      enqueueLive({
        kind: "tool",
        payload: {
          phase: "result",
          name: event.toolName,
          toolCallId: event.toolCallId,
          isError: event.isError,
          result: event.result,
          ...(event.hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
        },
      });
      return;
    }
    if (event.type === "agent_end") {
      lifecycleFinished = true;
      const lastAssistant = event.messages
        .toReversed()
        .find((message): message is AssistantMessage => message.role === "assistant");
      if (lastAssistant?.stopReason === "error") {
        terminalLiveEvent = {
          kind: "lifecycle",
          payload: {
            phase: "error",
            startedAt,
            endedAt: Date.now(),
            error: lastAssistant.errorMessage ?? "Worker inference failed.",
            fallbackExhaustedFailure: true,
          },
        };
      } else if (lastAssistant?.stopReason === "aborted") {
        terminalLiveEvent = {
          kind: "lifecycle",
          payload: {
            phase: "end",
            startedAt,
            endedAt: Date.now(),
            stopReason: "aborted",
            aborted: true,
          },
        };
      } else {
        terminalLiveEvent = {
          kind: "lifecycle",
          payload: { phase: "end", startedAt, endedAt: Date.now() },
        };
      }
    }
  };
  const enqueueRunFailure = (failure: { aborted: boolean; error: Error }) => {
    if (lifecycleFinished) {
      return;
    }
    if (failure.aborted) {
      terminalLiveEvent = {
        kind: "lifecycle",
        payload: {
          phase: "end",
          startedAt,
          endedAt: Date.now(),
          stopReason: "aborted",
          aborted: true,
        },
      };
    } else {
      terminalLiveEvent = {
        kind: "lifecycle",
        payload: {
          phase: "error",
          startedAt,
          endedAt: Date.now(),
          error: failure.error.message,
          fallbackExhaustedFailure: true,
        },
      };
    }
  };
  // Emits directly (not via the degradable preview queue): the terminal event drives
  // gateway turn settlement and must survive a degraded live stream.
  const emitTerminal = async () => {
    if (!terminalLiveEvent) {
      return;
    }
    await client.emit(boundLiveEvent(terminalLiveEvent));
  };
  return { handleSessionEvent, enqueueRunFailure, flush, emitTerminal };
}
