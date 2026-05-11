import type { ProviderStreamOptions } from "@earendil-works/pi-ai";
import {
  describeImageWithModelPayloadTransform,
  describeImagesWithModelPayloadTransform,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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
