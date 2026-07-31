import type { WorkerInferenceTerminalOutcome } from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { AssistantMessage } from "../../llm/types.js";

export type WorkerInferenceModelIdentity = {
  api: string;
  provider: string;
  model: string;
};

export function projectWorkerInferenceTerminalMessage(params: {
  message: AssistantMessage;
  modelIdentity: WorkerInferenceModelIdentity;
  stopReason: Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse">;
}): Extract<WorkerInferenceTerminalOutcome, { type: "done" }>["message"] {
  const content = params.message.content.map((part) => {
    switch (part.type) {
      case "text":
        return {
          type: part.type,
          text: part.text,
          ...(part.textSignature ? { textSignature: part.textSignature } : {}),
        };
      case "thinking":
        return {
          type: part.type,
          thinking: part.thinking,
          ...(part.thinkingSignature ? { thinkingSignature: part.thinkingSignature } : {}),
          ...(part.redacted !== undefined ? { redacted: part.redacted } : {}),
        };
      case "toolCall":
        return {
          type: part.type,
          id: part.id,
          name: part.name,
          arguments: structuredClone(part.arguments),
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
          ...(part.executionMode ? { executionMode: part.executionMode } : {}),
        };
      default:
        throw new Error("Unsupported assistant terminal content");
    }
  });
  const usage = params.message.usage;
  return {
    role: "assistant",
    // Provider adapters may retain transport scratch fields. Project the exact
    // closed worker schema so those fields cannot invalidate the terminal frame.
    content,
    api: params.modelIdentity.api,
    provider: params.modelIdentity.provider,
    model: params.modelIdentity.model,
    ...(params.message.responseModel ? { responseModel: params.message.responseModel } : {}),
    ...(params.message.responseId ? { responseId: params.message.responseId } : {}),
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      ...(usage.contextUsage?.state === "available"
        ? {
            contextUsage: {
              state: usage.contextUsage.state,
              promptTokens: usage.contextUsage.promptTokens,
              totalTokens: usage.contextUsage.totalTokens,
            },
          }
        : usage.contextUsage?.state === "unavailable"
          ? { contextUsage: { state: usage.contextUsage.state } }
          : {}),
      totalTokens: usage.totalTokens,
      cost: {
        input: usage.cost.input,
        output: usage.cost.output,
        cacheRead: usage.cost.cacheRead,
        cacheWrite: usage.cost.cacheWrite,
        total: usage.cost.total,
        ...(usage.cost.totalOrigin ? { totalOrigin: usage.cost.totalOrigin } : {}),
      },
    },
    stopReason: params.stopReason,
    timestamp: params.message.timestamp,
  };
}
