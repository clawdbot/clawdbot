import type { Api, AssistantMessage, Model } from "@openclaw/llm-core";
import { createEmptyTransportUsage } from "./transport-stream-shared.js";

export function createAssistantOutput(
  model: Pick<Model, "api" | "provider" | "id">,
  api: Api = model.api,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api,
    provider: model.provider,
    model: model.id,
    usage: createEmptyTransportUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
