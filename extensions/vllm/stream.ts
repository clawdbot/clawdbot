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
  isVllmDeepSeekV4ThinkingModel,
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
    // No leading `\b`: see thinking-policy.ts's isVllmNemotronThinkingModel for
    // why served-model-name aliases like "yk_nemotron-3-super" need this.
    /nemotron-3(?:[-_](?:nano|super|ultra))?\b/i.test(model.id)
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

function isVllmDeepSeekV4Model(model: {
  api?: unknown;
  provider?: unknown;
  id?: unknown;
}): boolean {
  return (
    model.api === "openai-completions" &&
    typeof model.provider === "string" &&
    normalizeProviderId(model.provider) === "vllm" &&
    typeof model.id === "string" &&
    isVllmDeepSeekV4ThinkingModel(model.id)
  );
}

function resolveVllmDeepSeekV4ReasoningEffort(thinkingLevel: VllmThinkingLevel): "high" | "max" {
  return thinkingLevel === "xhigh" || thinkingLevel === "max" ? "max" : "high";
}

function setVllmDeepSeekV4ThinkingChatTemplateKwargs(
  payload: Record<string, unknown>,
  thinkingLevel: VllmThinkingLevel,
): void {
  if (thinkingLevel === "off" || thinkingLevel === undefined) {
    // vLLM's DeepSeek V4 chat template already defaults to non-think, so there
    // is nothing to inject. This shouldPatch match still needs to fire for
    // every DeepSeek V4 id regardless of level: that is what marks the
    // request as plugin-handled and blocks the core DeepSeek V4 fallback
    // wrapper (src/agents/embedded-agent-runner/extra-params.ts) from sending
    // its hosted-API `thinking: { type }` top-level field instead, a shape
    // self-hosted vLLM chat templates do not understand.
    return;
  }
  const defaults = {
    thinking: true,
    reasoning_effort: resolveVllmDeepSeekV4ReasoningEffort(thinkingLevel),
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
  // Unlike Nemotron (gated to the "off" level only), DeepSeek V4 must engage
  // this wrapper at every thinking level, including "off": the core DeepSeek
  // V4 fallback wrapper matches by model id alone (no provider check), so
  // leaving this plugin wrapper undefined for any level would let that
  // fallback's hosted-API `thinking: { type }` wire format leak through for
  // self-hosted vLLM deployments.
  const isDeepSeekV4 = isVllmDeepSeekV4Model({
    api: "openai-completions",
    provider: ctx.provider,
    id: ctx.modelId,
  });
  if (!qwenFormat && !shouldHandleNemotron && !isDeepSeekV4) {
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
    (streamFn) =>
      createPayloadPatchStreamWrapper(
        streamFn,
        ({ payload }) => setVllmDeepSeekV4ThinkingChatTemplateKwargs(payload, ctx.thinkingLevel),
        {
          shouldPatch: ({ model }) =>
            model.api === "openai-completions" && isVllmDeepSeekV4Model(model),
        },
      ),
  );
}
