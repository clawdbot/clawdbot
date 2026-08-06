import type {
  WorkerTranscriptCommitRequestFrame,
  WorkerTranscriptMessage,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { AgentMessage } from "../agents/runtime/index.js";
import type { AssistantMessage } from "../llm/types.js";

const SIZE_FRAME_ID = "00000000-0000-4000-8000-000000000000";

export function cloneTextContent(part: { type: "text"; text: string; textSignature?: string }) {
  return {
    type: "text" as const,
    text: part.text,
    ...(part.textSignature ? { textSignature: part.textSignature } : {}),
  };
}

export function cloneImageContent(part: { type: "image"; data: string; mimeType: string }) {
  return { type: "image" as const, data: part.data, mimeType: part.mimeType };
}

export function cloneUsage(
  message: AssistantMessage,
): WorkerTranscriptMessage & { role: "assistant" } {
  return {
    role: "assistant",
    content: message.content.map((part) => {
      if (part.type === "text") {
        return cloneTextContent(part);
      }
      if (part.type === "thinking") {
        return {
          type: "thinking" as const,
          thinking: part.thinking,
          ...(part.thinkingSignature ? { thinkingSignature: part.thinkingSignature } : {}),
          ...(part.redacted === undefined ? {} : { redacted: part.redacted }),
        };
      }
      return {
        type: "toolCall" as const,
        id: part.id,
        name: part.name,
        arguments: structuredClone(part.arguments),
        ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        ...(part.executionMode ? { executionMode: part.executionMode } : {}),
      };
    }),
    api: message.api,
    provider: message.provider,
    model: message.model,
    ...(message.responseModel ? { responseModel: message.responseModel } : {}),
    ...(message.responseId ? { responseId: message.responseId } : {}),
    ...(message.diagnostics
      ? {
          diagnostics: message.diagnostics.map((diagnostic) => ({
            type: diagnostic.type,
            timestamp: diagnostic.timestamp,
            ...(diagnostic.error
              ? {
                  error: {
                    ...(diagnostic.error.name ? { name: diagnostic.error.name } : {}),
                    message: diagnostic.error.message,
                    ...(diagnostic.error.stack ? { stack: diagnostic.error.stack } : {}),
                    ...(diagnostic.error.code === undefined ? {} : { code: diagnostic.error.code }),
                  },
                }
              : {}),
            ...(diagnostic.details ? { details: structuredClone(diagnostic.details) } : {}),
          })),
        }
      : {}),
    usage: {
      input: message.usage.input,
      output: message.usage.output,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
      ...(message.usage.contextUsage
        ? { contextUsage: structuredClone(message.usage.contextUsage) }
        : {}),
      totalTokens: message.usage.totalTokens,
      cost: {
        input: message.usage.cost.input,
        output: message.usage.cost.output,
        cacheRead: message.usage.cost.cacheRead,
        cacheWrite: message.usage.cost.cacheWrite,
        total: message.usage.cost.total,
        ...(message.usage.cost.totalOrigin ? { totalOrigin: message.usage.cost.totalOrigin } : {}),
      },
    },
    stopReason: message.stopReason,
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    ...(message.errorCode ? { errorCode: message.errorCode } : {}),
    ...(message.errorType ? { errorType: message.errorType } : {}),
    ...(message.errorBody ? { errorBody: message.errorBody } : {}),
    timestamp: message.timestamp,
  };
}

export function toWorkerTranscriptMessage(
  message: AgentMessage,
): WorkerTranscriptMessage | undefined {
  if (message.role === "user") {
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content.map((part) =>
            part.type === "text" ? cloneTextContent(part) : cloneImageContent(part),
          );
    return { role: "user", content, timestamp: message.timestamp };
  }
  if (message.role === "assistant") {
    return cloneUsage(message);
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
  return undefined;
}

export function isWorkerTranscriptMessageFrameSafe(message: WorkerTranscriptMessage): boolean {
  const frame: WorkerTranscriptCommitRequestFrame = {
    type: "req",
    id: SIZE_FRAME_ID,
    method: "worker.transcript.commit",
    params: {
      runEpoch: Number.MAX_SAFE_INTEGER,
      seq: Number.MAX_SAFE_INTEGER,
      baseLeafId: "x".repeat(WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH),
      messages: [message],
    },
  };
  try {
    return Buffer.byteLength(JSON.stringify(frame), "utf8") <= WORKER_PROTOCOL_MAX_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}
