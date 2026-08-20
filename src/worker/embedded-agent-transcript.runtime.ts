import type { WorkerTranscriptMessage } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_TRANSCRIPT_MAX_BATCH_MESSAGES } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerInferenceContext } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { WORKER_INFERENCE_MAX_CONTEXT_MESSAGES } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { AgentMessage } from "../agents/runtime/index.js";
import type { AgentSessionWriteSettlementRunner } from "../agents/sessions/agent-session.js";
import type { Context, Message } from "../llm/types.js";
import {
  windowWorkerReplayMessages,
  type WorkerReplayMessageWindowUnavailable,
} from "./replay-message-window.js";
import {
  cloneImageContent,
  cloneTextContent,
  isWorkerTranscriptMessageFrameSafe,
  toWorkerTranscriptMessage,
  type WorkerMessageProjection,
  type WorkerProviderReplayUnavailable,
} from "./transcript-message.js";

export function toAgentMessage(message: WorkerTranscriptMessage): Message {
  if (message.role === "user") {
    return {
      role: "user",
      content: message.content.map((part) =>
        part.type === "text" ? cloneTextContent(part) : cloneImageContent(part),
      ),
      timestamp: message.timestamp,
    };
  }
  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content.map((part) =>
        part.type === "text" ? cloneTextContent(part) : cloneImageContent(part),
      ),
      ...(message.details === undefined ? {} : { details: structuredClone(message.details) }),
      isError: message.isError,
      timestamp: message.timestamp,
    };
  }
  return structuredClone(message);
}

function toWorkerInferenceMessage(
  message: Message,
): WorkerMessageProjection<WorkerInferenceContext["messages"][number]> {
  if (message.role === "user") {
    return {
      kind: "complete",
      message: {
        role: "user",
        content:
          typeof message.content === "string"
            ? message.content
            : message.content.map((part) =>
                part.type === "text" ? cloneTextContent(part) : cloneImageContent(part),
              ),
        timestamp: message.timestamp,
        ...(message.runtimeContextCarrier ? { runtimeContextCarrier: true } : {}),
      },
    };
  }
  const projected = toWorkerTranscriptMessage(message, "inference");
  if (!projected) {
    throw new Error(`Unsupported inference message role: ${message.role}`);
  }
  return projected;
}

type WorkerInferenceContextProjection =
  | { kind: "complete"; context: WorkerInferenceContext }
  | {
      kind: "provider-replay-unavailable";
      details: WorkerProviderReplayUnavailable | WorkerReplayMessageWindowUnavailable;
    };

export function toWorkerInferenceContext(context: Context): WorkerInferenceContextProjection {
  const windowed = windowWorkerReplayMessages(
    context.messages,
    WORKER_INFERENCE_MAX_CONTEXT_MESSAGES,
  );
  if (windowed.kind === "provider-replay-unavailable") {
    return windowed;
  }
  const messages: WorkerInferenceContext["messages"] = [];
  for (const message of windowed.messages) {
    const projected = toWorkerInferenceMessage(message);
    if (projected.kind === "provider-replay-unavailable") {
      return projected;
    }
    messages.push(projected.message);
  }
  return {
    kind: "complete",
    context: {
      ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
      messages,
      ...(context.tools
        ? {
            tools: context.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: structuredClone(tool.parameters),
            })),
          }
        : {}),
    },
  };
}

type WorkerTranscriptClient = {
  commit: (messages: WorkerTranscriptMessage[]) => Promise<void>;
};

type WorkerTranscriptRuntime = {
  onMessagePersisted: (message: AgentMessage) => void;
  withSessionWriteSettlement: AgentSessionWriteSettlementRunner;
};

export function createWorkerTranscriptRuntime(
  client: WorkerTranscriptClient,
): WorkerTranscriptRuntime {
  const pendingTranscriptMessages: WorkerTranscriptMessage[] = [];
  const onMessagePersisted = (message: AgentMessage) => {
    const projected = toWorkerTranscriptMessage(message, "transcript");
    if (!projected) {
      return;
    }
    if (projected.kind === "provider-replay-unavailable") {
      throw new Error(
        `Worker transcript cannot persist authoritative provider replay: ${projected.details.reason}.`,
      );
    }
    if (!isWorkerTranscriptMessageFrameSafe(projected.message)) {
      throw new Error("Worker transcript message exceeds the protocol payload limit.");
    }
    pendingTranscriptMessages.push(projected.message);
  };
  const flushTranscript = async () => {
    while (pendingTranscriptMessages.length > 0) {
      const batch = pendingTranscriptMessages.slice(0, WORKER_TRANSCRIPT_MAX_BATCH_MESSAGES);
      await client.commit(batch);
      pendingTranscriptMessages.splice(0, batch.length);
    }
  };
  let sessionWriteQueue: Promise<unknown> = Promise.resolve();
  const withSessionWriteSettlement: AgentSessionWriteSettlementRunner = <T>(
    operation: () => Promise<T> | T,
  ): Promise<T> => {
    const result = sessionWriteQueue.then(async () => {
      const value = await operation();
      await flushTranscript();
      return value;
    });
    sessionWriteQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return { onMessagePersisted, withSessionWriteSettlement };
}
