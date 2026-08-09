import type {
  WorkerTranscriptCommitRequestFrame,
  WorkerTranscriptMessage,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES,
  WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { AgentMessage } from "../agents/runtime/index.js";
import type { AssistantMessage, ProviderReplayState } from "../llm/types.js";

const SIZE_FRAME_ID = "00000000-0000-4000-8000-000000000000";
type WorkerTranscriptAssistantMessage = Extract<WorkerTranscriptMessage, { role: "assistant" }>;
export type WorkerProviderReplayUnavailable = {
  bytes: number;
  limitBytes: number;
  reason: "provider-replay-data-budget" | "transcript-commit-frame-budget";
};
type WorkerProviderReplayUnavailableProjection = {
  kind: "provider-replay-unavailable";
  details: WorkerProviderReplayUnavailable;
};
export type WorkerMessageProjection<T> =
  | { kind: "complete"; message: T }
  | WorkerProviderReplayUnavailableProjection;
type WorkerMessageProjectionPurpose = "inference" | "transcript";
export const WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE =
  "Cloud worker could not preserve authoritative provider replay. " +
  "Stop or reclaim the cloud worker, then retry locally.";

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

function providerReplayUnavailable(
  details: WorkerProviderReplayUnavailable,
): WorkerProviderReplayUnavailableProjection {
  return { kind: "provider-replay-unavailable", details };
}

function cloneProviderReplay(state: ProviderReplayState): ProviderReplayState {
  return {
    v: state.v,
    type: state.type,
    ...(state.id === undefined ? {} : { id: state.id }),
    data: state.data,
    ...(state.replayIndex === undefined ? {} : { replayIndex: state.replayIndex }),
    provider: state.provider,
    api: state.api,
    model: state.model,
    ...(state.baseUrlHash === undefined ? {} : { baseUrlHash: state.baseUrlHash }),
    ...(state.sessionHash === undefined ? {} : { sessionHash: state.sessionHash }),
    ...(state.authProfileHash === undefined ? {} : { authProfileHash: state.authProfileHash }),
  };
}

function workerTranscriptMessageFrameBytes(message: WorkerTranscriptMessage): number | undefined {
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
    return Buffer.byteLength(JSON.stringify(frame), "utf8");
  } catch {
    return undefined;
  }
}

export function projectWorkerProviderReplay<
  TMessage extends WorkerTranscriptAssistantMessage,
>(params: {
  message: TMessage;
  providerReplay: ProviderReplayState | undefined;
  purpose: WorkerMessageProjectionPurpose;
}): WorkerMessageProjection<TMessage> {
  if (!params.providerReplay) {
    return { kind: "complete", message: params.message };
  }
  const dataBytes = Buffer.byteLength(params.providerReplay.data, "utf8");
  if (dataBytes > WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES) {
    return providerReplayUnavailable({
      bytes: dataBytes,
      limitBytes: WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES,
      reason: "provider-replay-data-budget",
    });
  }
  const candidate = {
    ...params.message,
    providerReplay: cloneProviderReplay(params.providerReplay),
  };
  if (params.purpose === "inference") {
    return { kind: "complete", message: candidate };
  }
  const frameBytes = workerTranscriptMessageFrameBytes(candidate);
  if (frameBytes === undefined || frameBytes > WORKER_PROTOCOL_MAX_PAYLOAD_BYTES) {
    return providerReplayUnavailable({
      bytes: frameBytes ?? WORKER_PROTOCOL_MAX_PAYLOAD_BYTES + 1,
      limitBytes: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
      reason: "transcript-commit-frame-budget",
    });
  }
  return { kind: "complete", message: candidate };
}

function toWorkerAssistantMessage(message: AssistantMessage): WorkerTranscriptAssistantMessage {
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
  purpose: WorkerMessageProjectionPurpose,
): WorkerMessageProjection<WorkerTranscriptMessage> | undefined {
  if (message.role === "user") {
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content.map((part) =>
            part.type === "text" ? cloneTextContent(part) : cloneImageContent(part),
          );
    return { kind: "complete", message: { role: "user", content, timestamp: message.timestamp } };
  }
  if (message.role === "assistant") {
    return projectWorkerProviderReplay({
      message: toWorkerAssistantMessage(message),
      providerReplay: message.providerReplay,
      purpose,
    });
  }
  if (message.role === "toolResult") {
    return {
      kind: "complete",
      message: {
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: message.content.map((part) =>
          part.type === "text" ? cloneTextContent(part) : cloneImageContent(part),
        ),
        ...(message.details === undefined ? {} : { details: structuredClone(message.details) }),
        isError: message.isError,
        timestamp: message.timestamp,
      },
    };
  }
  return undefined;
}

export function isWorkerTranscriptMessageFrameSafe(message: WorkerTranscriptMessage): boolean {
  const frameBytes = workerTranscriptMessageFrameBytes(message);
  return frameBytes !== undefined && frameBytes <= WORKER_PROTOCOL_MAX_PAYLOAD_BYTES;
}
