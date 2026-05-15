import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createDeepSeekV4OpenAICompatibleThinkingWrapper,
  streamWithPayloadPatch,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { isOpencodeGoKimiNoReasoningModelId } from "./provider-catalog.js";

function isOpencodeGoDeepSeekV4ModelId(modelId: unknown): boolean {
  return modelId === "deepseek-v4-flash" || modelId === "deepseek-v4-pro";
}

export function createOpencodeGoDeepSeekV4Wrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): ProviderWrapStreamFnContext["streamFn"] {
  return createDeepSeekV4OpenAICompatibleThinkingWrapper({
    baseStreamFn,
    thinkingLevel,
    shouldPatchModel: (model) =>
      model.provider === "opencode-go" && isOpencodeGoDeepSeekV4ModelId(model.id),
  });
}

function stripReasoningParams(payloadObj: Record<string, unknown>): void {
  delete payloadObj.reasoning;
  delete payloadObj.reasoning_effort;
  delete payloadObj.reasoningEffort;
}

export function createOpencodeGoKimiNoReasoningWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
): ProviderWrapStreamFnContext["streamFn"] {
  if (!baseStreamFn) {
    return undefined;
  }
  const underlying = baseStreamFn;
  return (model, context, options) => {
    if (model.provider !== "opencode-go" || !isOpencodeGoKimiNoReasoningModelId(model.id)) {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, stripReasoningParams);
  };
}

export function createOpencodeGoWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): ProviderWrapStreamFnContext["streamFn"] {
  const kimiWrapped = createOpencodeGoKimiNoReasoningWrapper(baseStreamFn) ?? baseStreamFn;
  return createOpencodeGoDeepSeekV4Wrapper(kimiWrapped, thinkingLevel) ?? kimiWrapped;
}
