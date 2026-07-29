// Venice plugin module implements stream behavior.
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPayloadPatchStreamWrapper,
  normalizeOpenAICompatibleReasoningReplay,
} from "openclaw/plugin-sdk/provider-stream-shared";

function isVeniceDeepSeekV4ModelId(modelId: unknown): boolean {
  return modelId === "deepseek-v4-flash" || modelId === "deepseek-v4-pro";
}

export function createVeniceDeepSeekV4Wrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): ProviderWrapStreamFnContext["streamFn"] {
  void thinkingLevel;
  return createPayloadPatchStreamWrapper(baseStreamFn, ({ payload, model }) => {
    if (model.provider === "venice" && isVeniceDeepSeekV4ModelId(model.id)) {
      delete payload.thinking;
      delete payload.reasoning;
      delete payload.reasoning_effort;
      normalizeOpenAICompatibleReasoningReplay(payload, {
        thinkingEnabled: true,
        replaceNullReasoningContent: true,
      });
    }
  });
}
