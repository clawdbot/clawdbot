import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import {
  createPayloadPatchStreamWrapper,
  isOpenAICompatibleThinkingEnabled,
} from "openclaw/plugin-sdk/provider-stream-shared";

type VllmThinkingLevel = ProviderWrapStreamFnContext["thinkingLevel"];
type VllmQwenThinkingFormat = "chat-template" | "top-level";

function isVllmProviderId(providerId: string): boolean {
  return normalizeProviderId(providerId) === "vllm";
}

function normalizeQwenThinkingFormat(value: unknown): VllmQwenThinkingFormat | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (
    normalized === "chat-template" ||
    normalized === "chat-template-kwargs" ||
    normalized === "chat-template-kwarg" ||
    normalized === "chat-template-arguments"
  ) {
    return "chat-template";
  }
  if (
    normalized === "top-level" ||
    normalized === "enable-thinking" ||
    normalized === "request-body"
  ) {
    return "top-level";
  }
  return undefined;
}

function resolveVllmQwenThinkingFormat(
  extraParams: ProviderWrapStreamFnContext["extraParams"],
): VllmQwenThinkingFormat | undefined {
  return normalizeQwenThinkingFormat(
    extraParams?.qwenThinkingFormat ?? extraParams?.qwen_thinking_format,
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
      shouldPatch: ({ model }) => model.api === "openai-completions" && model.reasoning,
    },
  );
}

export function createVllmProviderThinkingWrapper(params: {
  baseStreamFn: StreamFn | undefined;
  qwenFormat?: VllmQwenThinkingFormat;
  thinkingLevel: VllmThinkingLevel;
}): StreamFn {
  const qwenWrapped = params.qwenFormat
    ? createVllmQwenThinkingWrapper({
        baseStreamFn: params.baseStreamFn,
        format: params.qwenFormat,
        thinkingLevel: params.thinkingLevel,
      })
    : params.baseStreamFn;
  return createPayloadPatchStreamWrapper(
    qwenWrapped,
    ({ payload: payloadObj }) => {
      setNemotronThinkingOffChatTemplateKwargs(payloadObj);
    },
    {
      shouldPatch: ({ model }) =>
        model.api === "openai-completions" &&
        params.thinkingLevel === "off" &&
        isVllmNemotronModel(model),
    },
  );
}

export function wrapVllmProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  if (!isVllmProviderId(ctx.provider) || (ctx.model && ctx.model.api !== "openai-completions")) {
    return undefined;
  }
  const qwenFormat = resolveVllmQwenThinkingFormat(ctx.extraParams);
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
  return createVllmProviderThinkingWrapper({
    baseStreamFn: ctx.streamFn,
    qwenFormat,
    thinkingLevel: ctx.thinkingLevel,
  });
}
