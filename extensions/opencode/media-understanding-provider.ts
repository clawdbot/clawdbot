import type { ProviderStreamOptions } from "openclaw/plugin-sdk/llm";
import {
  describeImageWithModelPayloadTransform,
  describeImagesWithModelPayloadTransform,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function stripOpencodeDisabledResponsesReasoningPayload(payload: unknown): void {
  if (!isRecord(payload)) {
    return;
  }
  const reasoning = payload.reasoning;
  if (reasoning === "none") {
    delete payload.reasoning;
    return;
  }
  if (!isRecord(reasoning) || reasoning.effort !== "none") {
    return;
  }
  delete payload.reasoning;
}

const stripDisabledResponsesReasoning: ProviderStreamOptions["onPayload"] = (payload) => {
  stripOpencodeDisabledResponsesReasoningPayload(payload);
  return undefined;
};

export const opencodeMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "opencode",
  capabilities: ["image"],
  defaultModels: {
    image: "gpt-5-nano",
  },
  describeImage: (request) =>
    describeImageWithModelPayloadTransform(request, stripDisabledResponsesReasoning),
  describeImages: (request) =>
    describeImagesWithModelPayloadTransform(request, stripDisabledResponsesReasoning),
};
