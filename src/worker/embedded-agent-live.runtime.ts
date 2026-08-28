import type { WorkerLiveEvent } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { redactAgentDiagnosticPayload } from "../agents/diagnostic-redaction.js";
import type { AgentMessage } from "../agents/runtime/index.js";
import type { AgentSessionEvent } from "../agents/sessions/agent-session.js";
import {
  resolveAssistantMessagePhase,
  type AssistantPhase,
} from "../shared/chat-message-content.js";
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
      return value;
    }
    return { truncated: true, preview: truncateLiveText(serialized) };
  } catch {
    return { truncated: true, preview: "[unserializable live payload]" };
  }
}

function redactLiveText(value: string): string {
  const redacted = redactAgentDiagnosticPayload(value);
  return truncateLiveText(typeof redacted === "string" ? redacted : "[unreadable diagnostic text]");
}

function boundLiveEvent(event: WorkerLiveEvent): WorkerLiveEvent {
  if (liveEventBytes(event) <= MAX_LIVE_EVENT_BYTES) {
    return event;
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

function readAssistantSnapshot(message: AgentMessage): { text: string; phase?: AssistantPhase } {
  if (message.role !== "assistant") {
    return { text: "" };
  }
  // A late commentary signature applies to its block, not unphased siblings.
  const blocks = message.content.flatMap((part) =>
    part.type === "text"
      ? [{ text: part.text, phase: resolveAssistantMessagePhase({ ...message, content: [part] }) }]
      : [],
  );
  const firstPhase = blocks[0]?.phase;
  const phase = blocks.every((block) => block.phase === firstPhase) ? firstPhase : undefined;
  return {
    text: blocks
      .filter((block) => phase === "commentary" || block.phase !== "commentary")
      .map((block) => block.text)
      .join(""),
    phase,
  };
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
  enqueuePreview: (event: WorkerLiveEvent) => boolean;
  emitTerminal: (event: WorkerLiveEvent) => Promise<void>;
};

type WorkerLiveRuntime = {
  handleSessionEvent: (event: AgentSessionEvent) => void;
  enqueueRunFailure: (failure: { aborted: boolean; error: Error }) => void;
  emitTerminal: () => Promise<void>;
};

export function createWorkerLiveRuntime(client: WorkerLiveClient): WorkerLiveRuntime {
  let previewEnabled = true;
  const enqueueLive = (event: WorkerLiveEvent) => {
    if (previewEnabled) {
      previewEnabled = client.enqueuePreview(boundLiveEvent(event));
    }
  };
  const startedAt = Date.now();
  let lifecycleFinished = false;
  // Terminal lifecycle events are deferred past the final transcript flush so the
  // gateway never sees an end/error before the authoritative transcript commit.
  let terminalLiveEvent: WorkerLiveEvent | undefined;
  let streamedText = "";
  let streamedPhase: AssistantPhase | undefined;
  let assistantMessageIndex = 0;
  let streamedThinking = "";
  const emitAssistantSnapshot = (message: AgentMessage) => {
    const { text, phase } = readAssistantSnapshot(message);
    if (text === streamedText && phase === streamedPhase) {
      return;
    }
    // Commentary never contributed to the answer, even if a final repeats its prefix.
    const previousText =
      streamedPhase === "commentary" && phase !== "commentary" ? "" : streamedText;
    const replace = !text.startsWith(previousText);
    enqueueLive({
      kind: "assistant",
      payload: {
        text,
        delta: replace ? text : text.slice(previousText.length),
        ...(replace ? { replace: true as const } : {}),
        ...(phase ? { phase } : {}),
        // Provider signatures can arrive only at text_end. Message lifecycle,
        // not those late ids, owns this cumulative snapshot's stable scope.
        itemId: `assistant-${assistantMessageIndex}`,
      },
    });
    streamedText = text;
    streamedPhase = phase;
  };
  const handleSessionEvent = (event: AgentSessionEvent) => {
    if (event.type === "agent_start") {
      enqueueLive({ kind: "lifecycle", payload: { phase: "start", startedAt } });
      return;
    }
    if (event.type === "message_start" && event.message.role === "assistant") {
      assistantMessageIndex += 1;
      streamedText = "";
      streamedPhase = undefined;
      streamedThinking = "";
      return;
    }
    if (event.type === "message_update") {
      if (
        event.assistantMessageEvent.type === "text_delta" ||
        event.assistantMessageEvent.type === "text_end"
      ) {
        emitAssistantSnapshot(event.message);
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
      emitAssistantSnapshot(event.message);
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
          args: redactAgentDiagnosticPayload(event.args),
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
          partialResult: redactAgentDiagnosticPayload(event.partialResult),
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
          result: redactAgentDiagnosticPayload(event.result),
          ...(event.hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
        },
      });
      return;
    }
    if (event.type === "agent_end") {
      lifecycleFinished = true;
      const lastAssistant = event.messages.findLast((message) => message.role === "assistant");
      const terminal = {
        startedAt,
        endedAt: Date.now(),
        ...(lastAssistant ? { stopReason: lastAssistant.stopReason } : {}),
      };
      terminalLiveEvent = {
        kind: "lifecycle",
        payload: {
          phase: "finishing",
          ...terminal,
          ...(lastAssistant?.stopReason === "error"
            ? { error: redactLiveText(lastAssistant.errorMessage ?? "Worker inference failed.") }
            : {}),
          ...(lastAssistant?.stopReason === "aborted" ? { aborted: true } : {}),
        },
      };
    }
  };
  const enqueueRunFailure = (failure: { aborted: boolean; error: Error }) => {
    if (lifecycleFinished) {
      return;
    }
    terminalLiveEvent = {
      kind: "lifecycle",
      payload: {
        phase: "finishing",
        startedAt,
        endedAt: Date.now(),
        ...(failure.aborted
          ? { stopReason: "aborted", aborted: true }
          : { error: redactLiveText(failure.error.message) }),
      },
    };
  };
  // Emits directly (not via the degradable preview queue): finishing is the durable
  // result fence that must reach the Gateway before post-worker reconciliation.
  const emitTerminal = async () => {
    if (!terminalLiveEvent) {
      return;
    }
    await client.emitTerminal(boundLiveEvent(terminalLiveEvent));
  };
  return { handleSessionEvent, enqueueRunFailure, emitTerminal };
}
