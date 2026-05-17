import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import {
  createPayloadPatchStreamWrapper,
  isOpenAICompatibleThinkingEnabled,
} from "openclaw/plugin-sdk/provider-stream-shared";

type QwenThinkingLevel = ProviderWrapStreamFnContext["thinkingLevel"];
type QwenThinkingFormat = string | undefined;

function isQwenProviderId(providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  return (
    normalized === "qwen" ||
    normalized === "modelstudio" ||
    normalized === "qwencloud" ||
    normalized === "dashscope"
  );
}

function setQwenChatTemplateThinking(payload: Record<string, unknown>, enabled: boolean): void {
  const existing = payload.chat_template_kwargs;
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    const next: Record<string, unknown> = {
      ...(existing as Record<string, unknown>),
      enable_thinking: enabled,
    };
    if (!Object.hasOwn(next, "preserve_thinking")) {
      next.preserve_thinking = true;
    }
    payload.chat_template_kwargs = next;
    return;
  }
  payload.chat_template_kwargs = {
    enable_thinking: enabled,
    preserve_thinking: true,
  };
}

function readQwenThinkingFormatFromModel(model: Parameters<StreamFn>[0]): QwenThinkingFormat {
  if (model.api !== "openai-completions") {
    return undefined;
  }
  const compat =
    model.compat && typeof model.compat === "object"
      ? (model.compat as { thinkingFormat?: unknown })
      : undefined;
  return typeof compat?.thinkingFormat === "string" ? compat.thinkingFormat : undefined;
}

export function createQwenThinkingWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel: QwenThinkingLevel,
  thinkingFormat?: QwenThinkingFormat,
): StreamFn {
  return createPayloadPatchStreamWrapper(
    baseStreamFn,
    ({ payload: payloadObj, model, options }) => {
      const enableThinking = isOpenAICompatibleThinkingEnabled({ thinkingLevel, options });
      const effectiveThinkingFormat = thinkingFormat ?? readQwenThinkingFormatFromModel(model);
      if (effectiveThinkingFormat === "qwen-chat-template") {
        setQwenChatTemplateThinking(payloadObj, enableThinking);
        delete payloadObj.enable_thinking;
      } else {
        payloadObj.enable_thinking = enableThinking;
      }
      delete payloadObj.reasoning_effort;
      delete payloadObj.reasoningEffort;
      delete payloadObj.reasoning;
    },
    {
      shouldPatch: ({ model }) => model.api === "openai-completions" && model.reasoning,
    },
  );
}

export function wrapQwenProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  if (!isQwenProviderId(ctx.provider) || (ctx.model && ctx.model.api !== "openai-completions")) {
    return undefined;
  }
  return createQwenThinkingWrapper(
    ctx.streamFn,
    ctx.thinkingLevel,
    ctx.model ? readQwenThinkingFormatFromModel(ctx.model) : undefined,
  );
}
