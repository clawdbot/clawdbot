import {
  createToolArgumentPreviewSchedule,
  parseStreamingJson,
  parseTerminalToolCallArguments,
  type ToolArgumentPreviewSchedule,
} from "@openclaw/ai/internal/runtime";
import { WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerInferenceContext,
  WorkerInferenceEventParams,
  WorkerInferenceModelRef,
  WorkerInferenceOptions,
  WorkerInferenceStartParams,
  WorkerInferenceTerminalOutcome,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import {
  invalidateComputerFrameIfMissing,
  type ComputerContextEpoch,
} from "../agents/tools/computer-tool.js";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
  ToolCall,
} from "../llm/types.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { fitWorkerReplayImages } from "./replay-message-window.js";
import {
  isWorkerTranscriptMessageFrameSafe,
  WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE,
} from "./transcript-message.js";
import type { WorkerInferenceProxyClient } from "./worker-rpc-clients.js";

type StreamingToolCall = ToolCall & {
  partialJson: string;
};

type WorkerInferenceStreamAdapterOptions = {
  client: WorkerInferenceProxyClient;
  sessionId: string;
  runEpoch: number;
  runId: string;
  turnId: string;
  modelRef: WorkerInferenceModelRef;
  computerContextEpoch?: ComputerContextEpoch;
};

type WorkerInferenceStreamRequest = {
  modelRef: WorkerInferenceModelRef;
  context: WorkerInferenceContext;
  options: WorkerInferenceOptions;
  signal?: AbortSignal;
};

function emptyAssistantMessage(modelRef: WorkerInferenceModelRef): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: modelRef.provider,
    model: modelRef.model,
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  };
}

function processInferenceEvent(
  payload: WorkerInferenceEventParams,
  partial: AssistantMessage,
  toolArgumentPreviewSchedules: Map<number, ToolArgumentPreviewSchedule>,
  tolerateMissingState: boolean,
): AssistantMessageEvent | undefined {
  const event = payload.event;
  switch (event.type) {
    case "start": {
      partial.api = event.resolvedModel.api as AssistantMessage["api"];
      partial.provider = event.resolvedModel.provider;
      partial.model = event.resolvedModel.model;
      partial.timestamp = event.timestamp;
      return { type: "start", partial };
    }
    case "text_start": {
      partial.content[event.contentIndex] = {
        type: "text",
        text: "",
        ...(event.contentSignature === undefined ? {} : { textSignature: event.contentSignature }),
      };
      return { type: "text_start", contentIndex: event.contentIndex, partial };
    }
    case "text_delta": {
      const content = partial.content[event.contentIndex];
      if (content?.type !== "text") {
        if (tolerateMissingState) {
          return undefined;
        }
        throw new Error("worker inference text delta has no active text block");
      }
      content.text += event.delta;
      return { type: "text_delta", contentIndex: event.contentIndex, delta: event.delta, partial };
    }
    case "text_end": {
      const content = partial.content[event.contentIndex];
      if (content?.type !== "text") {
        if (tolerateMissingState) {
          return undefined;
        }
        throw new Error("worker inference text end has no active text block");
      }
      if (event.contentSignature !== undefined) {
        content.textSignature = event.contentSignature;
      }
      return {
        type: "text_end",
        contentIndex: event.contentIndex,
        content: content.text,
        partial,
      };
    }
    case "thinking_start": {
      partial.content[event.contentIndex] = { type: "thinking", thinking: "" };
      return { type: "thinking_start", contentIndex: event.contentIndex, partial };
    }
    case "thinking_delta": {
      const content = partial.content[event.contentIndex];
      if (content?.type !== "thinking") {
        if (tolerateMissingState) {
          return undefined;
        }
        throw new Error("worker inference thinking delta has no active thinking block");
      }
      content.thinking += event.delta;
      return {
        type: "thinking_delta",
        contentIndex: event.contentIndex,
        delta: event.delta,
        partial,
      };
    }
    case "thinking_end": {
      const content = partial.content[event.contentIndex];
      if (content?.type !== "thinking") {
        if (tolerateMissingState) {
          return undefined;
        }
        throw new Error("worker inference thinking end has no active thinking block");
      }
      if (event.contentSignature !== undefined) {
        content.thinkingSignature = event.contentSignature;
      }
      return {
        type: "thinking_end",
        contentIndex: event.contentIndex,
        content: content.thinking,
        partial,
      };
    }
    case "toolcall_start": {
      const content = {
        type: "toolCall",
        id: event.id,
        name: event.toolName,
        arguments: {},
        partialJson: "",
      } satisfies StreamingToolCall;
      partial.content[event.contentIndex] = content;
      toolArgumentPreviewSchedules.set(event.contentIndex, createToolArgumentPreviewSchedule());
      return { type: "toolcall_start", contentIndex: event.contentIndex, partial };
    }
    case "toolcall_delta": {
      const content = partial.content[event.contentIndex];
      if (content?.type !== "toolCall") {
        if (tolerateMissingState) {
          return undefined;
        }
        throw new Error("worker inference tool delta has no active tool call");
      }
      const streaming = content as StreamingToolCall;
      streaming.partialJson += event.delta;
      const previewSchedule = toolArgumentPreviewSchedules.get(event.contentIndex);
      if (!previewSchedule) {
        throw new Error("worker inference tool delta has no preview schedule");
      }
      if (previewSchedule(streaming.partialJson.length)) {
        content.arguments = parseStreamingJson(streaming.partialJson);
      }
      return {
        type: "toolcall_delta",
        contentIndex: event.contentIndex,
        delta: event.delta,
        partial,
      };
    }
    case "toolcall_end": {
      const content = partial.content[event.contentIndex];
      if (content?.type !== "toolCall") {
        if (tolerateMissingState) {
          return undefined;
        }
        throw new Error("worker inference tool end has no active tool call");
      }
      const streaming = content as StreamingToolCall;
      content.arguments = parseTerminalToolCallArguments(streaming.partialJson);
      toolArgumentPreviewSchedules.delete(event.contentIndex);
      delete (content as Partial<StreamingToolCall>).partialJson;
      return { type: "toolcall_end", contentIndex: event.contentIndex, toolCall: content, partial };
    }
  }
  return undefined;
}

function terminalErrorMessage(
  partial: AssistantMessage,
  outcome: Extract<WorkerInferenceTerminalOutcome, { type: "error" }>,
): AssistantMessage {
  partial.stopReason = outcome.reason === "cancelled" ? "aborted" : "error";
  partial.errorMessage = outcome.message;
  if (outcome.usage) {
    partial.usage = structuredClone(outcome.usage);
  }
  return partial;
}

function transcriptSafeErrorMessage(
  modelRef: WorkerInferenceModelRef,
  message: AssistantMessage,
): AssistantMessage {
  if (isWorkerTranscriptMessageFrameSafe(message)) {
    return message;
  }
  const replacement = emptyAssistantMessage(modelRef);
  replacement.stopReason = message.stopReason === "aborted" ? "aborted" : "error";
  replacement.errorMessage = "Worker inference result exceeds the transcript message limit.";
  return replacement;
}

export function createWorkerInferenceStreamAdapter(
  adapter: WorkerInferenceStreamAdapterOptions,
): (request: WorkerInferenceStreamRequest) => AssistantMessageEventStreamLike {
  let modelCallSeq = 0;
  return (inferenceRequest) => {
    const stream = createAssistantMessageEventStream();
    const partial = emptyAssistantMessage(adapter.modelRef);
    const toolArgumentPreviewSchedules = new Map<number, ToolArgumentPreviewSchedule>();
    let streamHasGap = false;
    let settled = false;
    modelCallSeq += 1;
    const turnSuffix = `:${modelCallSeq}`;
    const identity = {
      runEpoch: adapter.runEpoch,
      sessionId: adapter.sessionId,
      runId: adapter.runId,
      turnId: `${adapter.turnId.slice(
        0,
        WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH - turnSuffix.length,
      )}${turnSuffix}`,
    };
    let request: WorkerInferenceStartParams = {
      ...identity,
      modelRef: inferenceRequest.modelRef,
      context: structuredClone(inferenceRequest.context),
      options: structuredClone(inferenceRequest.options),
    };
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      partial.stopReason = inferenceRequest.signal?.aborted ? "aborted" : "error";
      partial.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({
        type: "error",
        reason: partial.stopReason,
        error: transcriptSafeErrorMessage(adapter.modelRef, partial),
      });
      stream.end();
    };
    const finishAborted = () => {
      if (settled) {
        return;
      }
      settled = true;
      partial.stopReason = "aborted";
      partial.errorMessage = "Worker inference aborted.";
      stream.push({
        type: "error",
        reason: "aborted",
        error: transcriptSafeErrorMessage(adapter.modelRef, partial),
      });
      stream.end();
    };
    const abort = () => {
      void adapter.client
        .cancel(identity)
        .catch(() => undefined)
        .finally(finishAborted);
    };
    if (inferenceRequest.signal?.aborted) {
      partial.stopReason = "aborted";
      partial.errorMessage = "Worker inference aborted before start.";
      stream.push({
        type: "error",
        reason: "aborted",
        error: transcriptSafeErrorMessage(adapter.modelRef, partial),
      });
      stream.end();
      return stream;
    }
    try {
      const messages = fitWorkerReplayImages(
        request.context.messages,
        (candidateMessages) =>
          Buffer.byteLength(
            JSON.stringify({
              type: "req",
              // The dispatcher creates UUID request IDs: this has the exact same encoded size.
              id: "00000000-0000-4000-8000-000000000000",
              method: "worker.inference.start",
              params: { ...request, context: { ...request.context, messages: candidateMessages } },
            }),
            "utf8",
          ),
        adapter.computerContextEpoch?.frameToolCallId,
      );
      if (!messages) {
        throw new Error(
          request.context.messages.some(
            (message) => message.role === "assistant" && message.providerReplay !== undefined,
          )
            ? `${WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE} (inference payload limit)`
            : "Worker inference context exceeds the image transport limit. Use fewer or smaller images in this turn, then retry.",
        );
      }
      request = { ...request, context: { ...request.context, messages } };
      if (adapter.computerContextEpoch) {
        invalidateComputerFrameIfMissing({
          contextEpoch: adapter.computerContextEpoch,
          messages: messages.filter((message) => message.role === "toolResult"),
        });
      }
    } catch (error) {
      fail(error);
      return stream;
    }
    inferenceRequest.signal?.addEventListener("abort", abort, { once: true });
    void adapter.client
      .start(request, {
        onStreamGap: () => {
          streamHasGap = true;
        },
        onEvent: (event) => {
          const projected = processInferenceEvent(
            event,
            partial,
            toolArgumentPreviewSchedules,
            streamHasGap,
          );
          if (projected) {
            stream.push(projected);
          }
        },
      })
      .then((outcome) => {
        if (settled) {
          return;
        }
        settled = true;
        if (outcome.type === "done") {
          if (!isWorkerTranscriptMessageFrameSafe(outcome.message)) {
            const message = emptyAssistantMessage(adapter.modelRef);
            message.stopReason = "error";
            message.errorMessage = "Worker inference result exceeds the transcript message limit.";
            stream.push({ type: "error", reason: "error", error: message });
            stream.end();
            return;
          }
          const reason = outcome.message.stopReason;
          const message = structuredClone(outcome.message) as AssistantMessage;
          stream.push({ type: "done", reason, message });
          stream.end();
          return;
        }
        const message = transcriptSafeErrorMessage(
          adapter.modelRef,
          terminalErrorMessage(partial, outcome),
        );
        const reason = outcome.reason === "cancelled" ? "aborted" : "error";
        stream.push({ type: "error", reason, error: message });
        stream.end();
      })
      .catch(fail)
      .finally(() => {
        inferenceRequest.signal?.removeEventListener("abort", abort);
      });
    return stream;
  };
}
