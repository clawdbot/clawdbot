import { streamSimple } from "../llm/stream.js";
import type { Api, Model } from "../llm/types.js";
import {
  sanitizeGoogleThinkingPayload,
  streamWithPayloadPatch,
  type GoogleThinkingInputLevel,
} from "../plugin-sdk/provider-stream-shared.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import type { StreamFn } from "./runtime/index.js";

export const GOOGLE_SIMPLE_COMPLETION_API: Api = "openclaw-google-generative-ai-simple";

const SOURCE_API: Api = "google-generative-ai";

function resolveGoogleSimpleThinkingLevel(
  reasoning: unknown,
): GoogleThinkingInputLevel | undefined {
  switch (reasoning) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "adaptive":
    case "high":
    case "max":
    case "xhigh":
      return reasoning;
    default:
      return undefined;
  }
}

function buildGoogleSimpleCompletionStreamFn(): StreamFn {
  return (model, context, options) => {
    const googleModel = { ...model, api: SOURCE_API };
    return streamWithPayloadPatch(
      streamSimple as unknown as StreamFn,
      googleModel,
      context,
      options,
      (payload) => {
        sanitizeGoogleThinkingPayload({
          payload,
          modelId: model.id,
          thinkingLevel: resolveGoogleSimpleThinkingLevel(
            (options as { reasoning?: unknown } | undefined)?.reasoning,
          ),
        });
      },
    );
  };
}

export function prepareGoogleSimpleCompletionModel<TApi extends Api>(model: Model<TApi>): Model {
  if (model.api !== SOURCE_API) {
    return model;
  }
  ensureCustomApiRegistered(GOOGLE_SIMPLE_COMPLETION_API, buildGoogleSimpleCompletionStreamFn());
  return { ...model, api: GOOGLE_SIMPLE_COMPLETION_API };
}
