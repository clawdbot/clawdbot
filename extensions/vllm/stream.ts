// Vllm plugin module implements stream behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import {
  composeProviderStreamWrappers,
  createPayloadPatchStreamWrapper,
  isOpenAICompatibleThinkingEnabled,
  setQwenChatTemplateThinking,
} from "openclaw/plugin-sdk/provider-stream-shared";
import {
  resolveVllmQwenThinkingFormatFromCompat,
  type VllmQwenThinkingFormat,
} from "./thinking-policy.js";

type VllmThinkingLevel = ProviderWrapStreamFnContext["thinkingLevel"];

function isVllmProviderId(providerId: string): boolean {
  return normalizeProviderId(providerId) === "vllm";
}

function resolveVllmQwenThinkingFormat(
  ctx: Pick<ProviderWrapStreamFnContext, "model">,
): VllmQwenThinkingFormat | undefined {
  return resolveVllmQwenThinkingFormatFromCompat(ctx.model?.compat);
}

function isVllmNemotronModel(model: { api?: unknown; provider?: unknown; id?: unknown }): boolean {
  return (
    model.api === "openai-completions" &&
    typeof model.provider === "string" &&
    normalizeProviderId(model.provider) === "vllm" &&
    typeof model.id === "string" &&
    /\bnemotron-3(?:[-_](?:nano|super|ultra))?\b/i.test(model.id)
  );
}

function setNemotronThinkingOffChatTemplateKwargs(payload: Record<string, unknown>): void {
  const defaults = {
    enable_thinking: false,
    force_nonempty_content: true,
  };
  const existing = payload.chat_template_kwargs;
  payload.chat_template_kwargs =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? {
          ...defaults,
          ...(existing as Record<string, unknown>),
        }
      : defaults;
}

export function createVllmQwenThinkingWrapper(params: {
  baseStreamFn: StreamFn | undefined;
  format: VllmQwenThinkingFormat;
  thinkingLevel: VllmThinkingLevel;
}): StreamFn {
  return createPayloadPatchStreamWrapper(
    params.baseStreamFn,
    ({ payload: payloadObj, options }) => {
      const enableThinking = isOpenAICompatibleThinkingEnabled({
        thinkingLevel: params.thinkingLevel,
        options,
      });
      if (params.format === "chat-template") {
        setQwenChatTemplateThinking(payloadObj, enableThinking);
      } else {
        payloadObj.enable_thinking = enableThinking;
      }
      delete payloadObj.reasoning_effort;
      delete payloadObj.reasoningEffort;
      delete payloadObj.reasoning;
    },
    {
      shouldPatch: ({ model }) => model.api === "openai-completions" && (model.reasoning ?? true),
    },
  );
}

export function wrapVllmProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  if (!isVllmProviderId(ctx.provider) || (ctx.model && ctx.model.api !== "openai-completions")) {
    return undefined;
  }
  const qwenFormat = resolveVllmQwenThinkingFormat(ctx);
  const shouldHandleNemotron =
    ctx.thinkingLevel === "off" &&
    isVllmNemotronModel({
      api: "openai-completions",
      provider: ctx.provider,
      id: ctx.modelId,
    });
  if (!qwenFormat && !shouldHandleNemotron) {
    return undefined;
  }
  return composeProviderStreamWrappers(
    ctx.streamFn,
    qwenFormat &&
      ((streamFn) =>
        createVllmQwenThinkingWrapper({
          baseStreamFn: streamFn,
          format: qwenFormat,
          thinkingLevel: ctx.thinkingLevel,
        })),
    (streamFn) =>
      createPayloadPatchStreamWrapper(
        streamFn,
        ({ payload }) => setNemotronThinkingOffChatTemplateKwargs(payload),
        {
          shouldPatch: ({ model }) =>
            model.api === "openai-completions" &&
            ctx.thinkingLevel === "off" &&
            isVllmNemotronModel(model),
        },
      ),
  );
}
