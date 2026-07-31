// Hugging Face stream wrappers normalize provider-specific Qwen request fields.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import {
  createPayloadPatchStreamWrapper,
  isOpenAICompatibleThinkingEnabled,
  setQwenChatTemplateThinking,
} from "openclaw/plugin-sdk/provider-stream-shared";

const HUGGINGFACE_PROVIDER_ID = "huggingface";

function usesQwenChatTemplateThinking(model: ProviderWrapStreamFnContext["model"]): boolean {
  if (!model?.compat || typeof model.compat !== "object") {
    return false;
  }
  return (model.compat as { thinkingFormat?: unknown }).thinkingFormat === "qwen-chat-template";
}

function createHuggingfaceQwenThinkingWrapper(ctx: ProviderWrapStreamFnContext): StreamFn {
  return createPayloadPatchStreamWrapper(
    ctx.streamFn,
    ({ payload, options }) => {
      setQwenChatTemplateThinking(
        payload,
        isOpenAICompatibleThinkingEnabled({
          thinkingLevel: ctx.thinkingLevel,
          options,
        }),
      );
      delete payload.reasoning_effort;
      delete payload.reasoningEffort;
      delete payload.reasoning;
    },
    {
      shouldPatch: ({ model }) =>
        model.api === "openai-completions" &&
        normalizeProviderId(model.provider) === HUGGINGFACE_PROVIDER_ID &&
        usesQwenChatTemplateThinking(model),
    },
  );
}

export function wrapHuggingfaceProviderStream(
  ctx: ProviderWrapStreamFnContext,
): StreamFn | undefined {
  if (
    normalizeProviderId(ctx.provider) !== HUGGINGFACE_PROVIDER_ID ||
    (ctx.model && ctx.model.api !== "openai-completions") ||
    !usesQwenChatTemplateThinking(ctx.model)
  ) {
    return undefined;
  }
  return createHuggingfaceQwenThinkingWrapper(ctx);
}
