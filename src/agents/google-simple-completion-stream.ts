/**
 * Google simple-completion stream adapter.
 *
 * This registers a patched Google stream API that keeps the normal Google
 * backend but sanitizes unsupported thinking payload options for simple models.
 */
import { clampThinkingLevel } from "@openclaw/ai/internal/runtime";
import { streamSimple } from "../llm/stream.js";
import type { Api, Model, ModelThinkingLevel } from "../llm/types.js";
import {
  sanitizeGoogleThinkingPayload,
  streamWithPayloadPatch,
  type GoogleThinkingInputLevel,
} from "../plugin-sdk/provider-stream-shared.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import type { StreamFn } from "./runtime/index.js";

/** Custom API id for the Google simple-completion stream adapter. */
const GOOGLE_SIMPLE_COMPLETION_API: Api = "openclaw-google-generative-ai-simple";

const SOURCE_API: Api = "google-generative-ai";

function resolveGoogleSimpleThinkingLevel(
  model: Model,
  reasoning: unknown,
): GoogleThinkingInputLevel | undefined {
  switch (reasoning) {
    case "adaptive":
      return reasoning;
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "max":
    case "xhigh":
      return clampThinkingLevel(model, reasoning as ModelThinkingLevel);
    default:
      return undefined;
  }
}

function buildGoogleSimpleCompletionStreamFn(): StreamFn {
  return (model, context, options) => {
    const googleModel: Model = { ...model, api: SOURCE_API };
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
            googleModel,
            (options as { reasoning?: unknown } | undefined)?.reasoning,
          ),
        });
      },
    );
  };
}

/** Rewrites Google generative-ai models to the simple-completion adapter when needed. */
export function prepareGoogleSimpleCompletionModel<TApi extends Api>(model: Model<TApi>): Model {
  if (model.api !== SOURCE_API) {
    return model;
  }
  ensureCustomApiRegistered(GOOGLE_SIMPLE_COMPLETION_API, buildGoogleSimpleCompletionStreamFn());
  return { ...model, api: GOOGLE_SIMPLE_COMPLETION_API };
}
