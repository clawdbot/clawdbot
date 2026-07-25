import type { WorkerTranscriptMessage } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_TRANSCRIPT_MAX_BATCH_MESSAGES } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerInferenceContext } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { WORKER_INFERENCE_MAX_CONTEXT_MESSAGES } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { AgentMessage } from "../agents/runtime/index.js";
import type { AgentSessionWriteLockRunner } from "../agents/sessions/agent-session.js";
import type { Context, Message } from "../llm/types.js";
import {
  cloneImageContent,
  cloneTextContent,
  cloneUsage,
  isWorkerTranscriptMessageFrameSafe,
  toWorkerTranscriptMessage,
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
  return {
    ...cloneUsage(message),
    diagnostics: message.diagnostics?.map((diagnostic) => structuredClone(diagnostic)),
  };
}

function toWorkerInferenceMessage(message: Message): WorkerInferenceContext["messages"][number] {
  if (message.role === "user") {
    return {
      role: "user",
      content:
        typeof message.content === "string"
          ? message.content
          : message.content.map((part) =>
              part.type === "text" ? cloneTextContent(part) : cloneImageContent(part),
            ),
      timestamp: message.timestamp,
      ...(message.runtimeContextCarrier ? { runtimeContextCarrier: true } : {}),
    };
  }
  const projected = toWorkerTranscriptMessage(message);
  if (!projected) {
    throw new Error(`Unsupported inference message role: ${message.role}`);
  }
  return projected;
}

function windowWorkerInferenceMessages(messages: Context["messages"]): Context["messages"] {
  if (messages.length <= WORKER_INFERENCE_MAX_CONTEXT_MESSAGES) {
    return messages;
  }
  const minimumStart = messages.length - WORKER_INFERENCE_MAX_CONTEXT_MESSAGES;
  // Start at a user turn when possible so truncation cannot orphan a tool result
  // from the assistant tool call that owns it.
  for (let index = minimumStart; index < messages.length; index += 1) {
    if (messages[index]?.role === "user") {
      return messages.slice(index);
    }
  }
  throw new Error("Worker inference context has no complete user turn within the message limit.");
}

export function toWorkerInferenceContext(context: Context): WorkerInferenceContext {
  return {
    ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
    messages: windowWorkerInferenceMessages(context.messages).map(toWorkerInferenceMessage),
    ...(context.tools
      ? {
          tools: context.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: structuredClone(tool.parameters),
          })),
        }
      : {}),
  };
}

type WorkerTranscriptClient = {
  commit: (messages: WorkerTranscriptMessage[]) => Promise<void>;
};

type WorkerTranscriptRuntime = {
  onMessagePersisted: (message: AgentMessage) => void;
  withSessionWriteLock: AgentSessionWriteLockRunner;
};

export function createWorkerTranscriptRuntime(
  client: WorkerTranscriptClient,
): WorkerTranscriptRuntime {
  const pendingTranscriptMessages: WorkerTranscriptMessage[] = [];
  const onMessagePersisted = (message: AgentMessage) => {
    const projected = toWorkerTranscriptMessage(message);
    if (projected) {
      if (!isWorkerTranscriptMessageFrameSafe(projected)) {
        throw new Error("Worker transcript message exceeds the protocol payload limit.");
      }
      pendingTranscriptMessages.push(projected);
    }
  };
  const flushTranscript = async () => {
    while (pendingTranscriptMessages.length > 0) {
      const batch = pendingTranscriptMessages.slice(0, WORKER_TRANSCRIPT_MAX_BATCH_MESSAGES);
      await client.commit(batch);
      pendingTranscriptMessages.splice(0, batch.length);
    }
  };
  let sessionWriteQueue: Promise<unknown> = Promise.resolve();
  const withSessionWriteLock: AgentSessionWriteLockRunner = <T>(
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
  return { onMessagePersisted, withSessionWriteLock };
}
