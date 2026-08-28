// Qwen plugin module implements stream behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import {
  createPayloadPatchStreamWrapper,
  isOpenAICompatibleThinkingEnabled,
  normalizeOpenAICompatibleReasoningReplay,
  setQwenChatTemplateThinking,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { asOptionalRecord as asPayloadRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isQwen38ModelId,
  isQwenTokenPlanDeepSeekV4ModelId,
  isQwenTokenPlanGlmModelId,
  isQwenTokenPlanKimiModelId,
  isQwenTokenPlanThinkingOnlyModelId,
  QWEN_TOKEN_PLAN_LEGACY_PROVIDER_ID,
  QWEN_TOKEN_PLAN_PROVIDER_ID,
  supportsQwenTokenPlanGlmMaxThinking,
} from "./models.js";

type QwenThinkingLevel = ProviderWrapStreamFnContext["thinkingLevel"];
type QwenThinkingFormat = string | undefined;
type QwenThinkingContract =
  | { family: "qwen-3.8" }
  | { family: "deepseek-v4" }
  | { family: "kimi" }
  | { family: "glm"; supportsMax: boolean };

function resolveQwenThinkingLevel(
  thinkingLevel: QwenThinkingLevel,
  options: Parameters<StreamFn>[2],
): QwenThinkingLevel {
  const runtimeOptions = (options ?? {}) as { reasoningEffort?: unknown; reasoning?: unknown };
  const raw = runtimeOptions.reasoningEffort ?? runtimeOptions.reasoning ?? thinkingLevel;
  return normalizeQwenThinkingLevel(raw, thinkingLevel);
}

function normalizeQwenThinkingLevel(raw: unknown, fallback?: QwenThinkingLevel): QwenThinkingLevel {
  if (typeof raw !== "string") {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "none") {
    return "off";
  }
  switch (normalized) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return normalized;
    default:
      return fallback;
  }
}

function isQwenProviderId(providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  return (
    normalized === "qwen" ||
    normalized === QWEN_TOKEN_PLAN_PROVIDER_ID ||
    normalized === QWEN_TOKEN_PLAN_LEGACY_PROVIDER_ID ||
    normalized === "modelstudio" ||
    normalized === "qwencloud" ||
    normalized === "dashscope"
  );
}

function isQwenTokenPlanProviderId(providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  return (
    normalized === QWEN_TOKEN_PLAN_PROVIDER_ID || normalized === QWEN_TOKEN_PLAN_LEGACY_PROVIDER_ID
  );
}

function resolveQwenThinkingContract(
  providerId: string,
  modelId: string,
): QwenThinkingContract | undefined {
  if (isQwen38ModelId(modelId)) {
    return { family: "qwen-3.8" };
  }
  if (!isQwenTokenPlanProviderId(providerId)) {
    return undefined;
  }
  if (isQwenTokenPlanDeepSeekV4ModelId(modelId)) {
    return { family: "deepseek-v4" };
  }
  if (isQwenTokenPlanKimiModelId(modelId)) {
    return { family: "kimi" };
  }
  if (isQwenTokenPlanGlmModelId(modelId)) {
    return { family: "glm", supportsMax: supportsQwenTokenPlanGlmMaxThinking(modelId) };
  }
  return undefined;
}

function patchQwen38Payload(
  payload: Record<string, unknown>,
  thinkingLevel: QwenThinkingLevel,
  enableThinking: boolean,
): void {
  delete payload.thinking;
  // An explicit token budget owns reasoning depth; Qwen rejects it together
  // with reasoning_effort. Preserve caller budgets instead of overriding them.
  if (!enableThinking || payload.thinking_budget !== undefined) {
    delete payload.reasoning_effort;
    return;
  }
  payload.reasoning_effort =
    thinkingLevel === "minimal" || thinkingLevel === "low"
      ? "low"
      : thinkingLevel === "medium"
        ? "medium"
        : "xhigh";
}

function patchTokenPlanDeepSeekV4Payload(
  payload: Record<string, unknown>,
  thinkingLevel: QwenThinkingLevel,
  enableThinking: boolean,
): void {
  delete payload.thinking;
  if (!enableThinking) {
    delete payload.reasoning_effort;
    normalizeOpenAICompatibleReasoningReplay(payload, { thinkingEnabled: false });
    return;
  }
  payload.reasoning_effort = thinkingLevel === "xhigh" || thinkingLevel === "max" ? "max" : "high";
  normalizeOpenAICompatibleReasoningReplay(payload, { thinkingEnabled: true });
}

function patchTokenPlanKimiPayload(
  payload: Record<string, unknown>,
  enableThinking: boolean,
): void {
  delete payload.thinking;
  delete payload.reasoning_effort;
  if (enableThinking) {
    normalizeOpenAICompatibleReasoningReplay(payload, {
      thinkingEnabled: true,
      shouldBackfillAssistantMessage: (message) =>
        Array.isArray(message.tool_calls) && message.tool_calls.length > 0,
    });
  }
}

function normalizeTokenPlanThinkingToolChoice(
  payload: Record<string, unknown>,
  enableThinking: boolean,
  forceThinking: boolean,
): boolean {
  if (!enableThinking) {
    return false;
  }
  const toolChoice = payload.tool_choice;
  const toolChoiceType = asPayloadRecord(toolChoice)?.type;
  if (toolChoiceType === "auto" || toolChoiceType === "none") {
    payload.tool_choice = toolChoiceType;
    return true;
  }
  const toolChoiceCompatible = toolChoice == null || toolChoice === "auto" || toolChoice === "none";
  if (toolChoiceCompatible) {
    return true;
  }
  const pinnedToolChoice = toolChoiceType === "tool" || toolChoiceType === "function";
  if (!forceThinking && pinnedToolChoice) {
    payload.enable_thinking = false;
    return false;
  }
  payload.tool_choice = "auto";
  return true;
}

function enforceQwenPayloadAfterCaller(
  payload: Record<string, unknown>,
  tokenPlanContract: QwenThinkingContract | undefined,
  forceThinking: boolean,
  requestedEnableThinking: boolean,
  requestedThinkingLevel: QwenThinkingLevel,
): void {
  const hasPayloadThinking = typeof payload.enable_thinking === "boolean";
  let enableThinking =
    forceThinking ||
    (hasPayloadThinking ? payload.enable_thinking !== false : requestedEnableThinking);
  const rawThinkingLevel =
    typeof payload.reasoning_effort === "string"
      ? payload.reasoning_effort
      : hasPayloadThinking
        ? undefined
        : requestedThinkingLevel;
  if (
    !forceThinking &&
    (rawThinkingLevel === "off" ||
      (tokenPlanContract?.family === "qwen-3.8" && rawThinkingLevel === "none"))
  ) {
    enableThinking = false;
  }
  payload.enable_thinking = enableThinking;
  enableThinking = normalizeTokenPlanThinkingToolChoice(payload, enableThinking, forceThinking);
  if (tokenPlanContract?.family === "qwen-3.8") {
    patchQwen38Payload(payload, normalizeQwenThinkingLevel(rawThinkingLevel), enableThinking);
  } else if (tokenPlanContract?.family === "deepseek-v4") {
    const thinkingLevel =
      rawThinkingLevel === "xhigh" || rawThinkingLevel === "max" ? "max" : "high";
    patchTokenPlanDeepSeekV4Payload(payload, thinkingLevel, enableThinking);
  } else if (tokenPlanContract?.family === "kimi") {
    patchTokenPlanKimiPayload(payload, enableThinking);
  } else if (tokenPlanContract?.family === "glm") {
    if (Array.isArray(payload.tools) && payload.tools.length > 0) {
      payload.tool_stream = true;
    }
    if (rawThinkingLevel === "none" && enableThinking) {
      delete payload.thinking;
    } else {
      const thinkingLevel = normalizeQwenThinkingLevel(rawThinkingLevel);
      patchTokenPlanGlmPayload(
        payload,
        thinkingLevel,
        enableThinking,
        tokenPlanContract.supportsMax,
      );
    }
  } else {
    delete payload.thinking;
    delete payload.reasoning_effort;
  }
  delete payload.reasoningEffort;
  delete payload.reasoning;
}

function finalizeQwenPayloadAfterCaller(
  value: unknown,
  fallbackPayload: Record<string, unknown> | undefined,
  tokenPlanContract: QwenThinkingContract | undefined,
  forceThinking: boolean,
  requestedEnableThinking: boolean,
  requestedThinkingLevel: QwenThinkingLevel,
): unknown {
  const finalPayload = asPayloadRecord(value) ?? fallbackPayload;
  if (finalPayload) {
    enforceQwenPayloadAfterCaller(
      finalPayload,
      tokenPlanContract,
      forceThinking,
      requestedEnableThinking,
      requestedThinkingLevel,
    );
  }
  return value;
}

function createQwenConstraintWrapper(
  baseStreamFn: StreamFn | undefined,
  tokenPlanContract: QwenThinkingContract | undefined,
  forceThinking: boolean,
  thinkingLevel: QwenThinkingLevel,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.api !== "openai-completions" || (!model.reasoning && !forceThinking)) {
      return underlying(model, context, options);
    }
    const requestedThinkingLevel = resolveQwenThinkingLevel(thinkingLevel, options);
    const requestedEnableThinking =
      forceThinking || isOpenAICompatibleThinkingEnabled({ thinkingLevel, options });
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload(payload, payloadModel) {
        const payloadObj = asPayloadRecord(payload);
        const result = originalOnPayload?.(payload, payloadModel);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          return Promise.resolve(result).then((resolved) =>
            finalizeQwenPayloadAfterCaller(
              resolved,
              payloadObj,
              tokenPlanContract,
              forceThinking,
              requestedEnableThinking,
              requestedThinkingLevel,
            ),
          );
        }
        return finalizeQwenPayloadAfterCaller(
          result,
          payloadObj,
          tokenPlanContract,
          forceThinking,
          requestedEnableThinking,
          requestedThinkingLevel,
        );
      },
    });
  };
}

function patchTokenPlanGlmPayload(
  payload: Record<string, unknown>,
  thinkingLevel: QwenThinkingLevel,
  enableThinking: boolean,
  supportsMax: boolean,
): void {
  delete payload.thinking;
  if (!enableThinking) {
    delete payload.reasoning_effort;
    return;
  }
  switch (thinkingLevel) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      payload.reasoning_effort = thinkingLevel;
      return;
    case "max":
      payload.reasoning_effort = supportsMax ? "max" : "xhigh";
      return;
    default:
      delete payload.reasoning_effort;
  }
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
  forceThinking = false,
  tokenPlanContract?: QwenThinkingContract,
): StreamFn {
  return createPayloadPatchStreamWrapper(
    baseStreamFn,
    ({ payload: payloadObj, model, options }) => {
      // Thinking-only Token Plan models reject disabled thinking, including /think off.
      const effectiveThinkingLevel = resolveQwenThinkingLevel(thinkingLevel, options);
      const enableThinking =
        forceThinking || isOpenAICompatibleThinkingEnabled({ thinkingLevel, options });
      const effectiveThinkingFormat = thinkingFormat ?? readQwenThinkingFormatFromModel(model);
      if (effectiveThinkingFormat === "qwen-chat-template") {
        setQwenChatTemplateThinking(payloadObj, enableThinking);
        delete payloadObj.enable_thinking;
      } else {
        payloadObj.enable_thinking = enableThinking;
      }
      if (isQwen38ModelId(model.id) && effectiveThinkingFormat === undefined) {
        patchQwen38Payload(payloadObj, effectiveThinkingLevel, enableThinking);
      } else if (tokenPlanContract?.family === "deepseek-v4") {
        // DashScope's OpenAI endpoint uses enable_thinking, while DeepSeek V4
        // also requires replay reasoning_content and high/max effort mapping.
        patchTokenPlanDeepSeekV4Payload(payloadObj, effectiveThinkingLevel, enableThinking);
      } else if (tokenPlanContract?.family === "kimi") {
        // Final Token Plan constraints own Kimi replay after caller hooks and
        // tool-choice normalization; this pass only strips generic fields.
        patchTokenPlanKimiPayload(payloadObj, false);
      } else if (tokenPlanContract?.family === "glm") {
        // GLM accepts OpenClaw's reasoning levels directly; only GLM 5.2 accepts max.
        patchTokenPlanGlmPayload(
          payloadObj,
          effectiveThinkingLevel,
          enableThinking,
          tokenPlanContract.supportsMax,
        );
      } else {
        delete payloadObj.reasoning_effort;
      }
      delete payloadObj.reasoningEffort;
      delete payloadObj.reasoning;
    },
    {
      shouldPatch: ({ model }) =>
        model.api === "openai-completions" && (model.reasoning || forceThinking),
    },
  );
}

export function wrapQwenProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  if (!isQwenProviderId(ctx.provider) || (ctx.model && ctx.model.api !== "openai-completions")) {
    return undefined;
  }
  const thinkingFormat = ctx.model ? readQwenThinkingFormatFromModel(ctx.model) : undefined;
  const explicitLegacyThinkingFormat =
    normalizeProviderId(ctx.provider) === QWEN_TOKEN_PLAN_LEGACY_PROVIDER_ID &&
    thinkingFormat !== undefined;
  if (explicitLegacyThinkingFormat && thinkingFormat !== "qwen-chat-template") {
    return ctx.streamFn;
  }
  const tokenPlanContract = explicitLegacyThinkingFormat
    ? undefined
    : resolveQwenThinkingContract(ctx.provider, ctx.modelId);
  const tokenPlanProvider = isQwenTokenPlanProviderId(ctx.provider);
  // The picker catalog is intentionally curated; direct Token Plan refs still
  // need provider constraints unless an explicit transport format owns them.
  const useWireConstraints =
    (tokenPlanProvider || tokenPlanContract?.family === "qwen-3.8") &&
    !explicitLegacyThinkingFormat &&
    thinkingFormat === undefined;
  const forceThinking = useWireConstraints && isQwenTokenPlanThinkingOnlyModelId(ctx.modelId);
  let streamFn = createQwenThinkingWrapper(
    ctx.streamFn,
    ctx.thinkingLevel,
    thinkingFormat,
    forceThinking,
    tokenPlanContract,
  );
  if (useWireConstraints) {
    // Config and request extra_body hooks run outside plugin wrappers. Reapply
    // model wire constraints after those hooks so invalid fields cannot escape.
    streamFn = createQwenConstraintWrapper(
      streamFn,
      tokenPlanContract,
      forceThinking,
      ctx.thinkingLevel,
    );
  }
  return streamFn;
}
