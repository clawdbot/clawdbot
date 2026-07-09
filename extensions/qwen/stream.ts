// Qwen plugin module implements stream behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import {
  createPayloadPatchStreamWrapper,
  isOpenAICompatibleThinkingEnabled,
  setQwenChatTemplateThinking,
} from "openclaw/plugin-sdk/provider-stream-shared";
import {
  isQwenTokenPlanDeepSeekV4ModelId,
  isQwenTokenPlanGlmModelId,
  isQwenTokenPlanKimiModelId,
  isQwenTokenPlanModelId,
  isQwenTokenPlanThinkingOnlyModelId,
  QWEN_TOKEN_PLAN_LEGACY_PROVIDER_ID,
  QWEN_TOKEN_PLAN_PROVIDER_ID,
  supportsQwenTokenPlanGlmMaxThinking,
} from "./models.js";

type QwenThinkingLevel = ProviderWrapStreamFnContext["thinkingLevel"];
type QwenThinkingFormat = string | undefined;
type QwenTokenPlanThinkingContract =
  | { family: "deepseek-v4" }
  | { family: "kimi" }
  | { family: "glm"; supportsMax: boolean };

function asPayloadRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolveQwenThinkingLevel(
  thinkingLevel: QwenThinkingLevel,
  options: Parameters<StreamFn>[2],
): QwenThinkingLevel {
  const runtimeOptions = (options ?? {}) as { reasoningEffort?: unknown; reasoning?: unknown };
  const raw = runtimeOptions.reasoningEffort ?? runtimeOptions.reasoning ?? thinkingLevel;
  if (typeof raw !== "string") {
    return thinkingLevel;
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
      return thinkingLevel;
  }
}

function isQwenProviderId(providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  return (
    normalized === "qwen" ||
    normalized === "qwen-oauth" ||
    normalized === "qwen-portal" ||
    normalized === "qwen-cli" ||
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

function resolveQwenTokenPlanThinkingContract(
  providerId: string,
  modelId: string,
): QwenTokenPlanThinkingContract | undefined {
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

function patchTokenPlanDeepSeekV4Payload(
  payload: Record<string, unknown>,
  thinkingLevel: QwenThinkingLevel,
  enableThinking: boolean,
): void {
  delete payload.thinking;
  if (!enableThinking) {
    delete payload.reasoning_effort;
    if (Array.isArray(payload.messages)) {
      for (const message of payload.messages) {
        if (message && typeof message === "object") {
          delete (message as Record<string, unknown>).reasoning_content;
        }
      }
    }
    return;
  }
  payload.reasoning_effort = thinkingLevel === "xhigh" || thinkingLevel === "max" ? "max" : "high";
  if (!Array.isArray(payload.messages)) {
    return;
  }
  for (const message of payload.messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    if (record.role === "assistant" && !("reasoning_content" in record)) {
      record.reasoning_content = "";
    }
  }
}

function patchTokenPlanKimiPayload(
  payload: Record<string, unknown>,
  enableThinking: boolean,
): void {
  delete payload.thinking;
  delete payload.reasoning_effort;
  if (!enableThinking || !Array.isArray(payload.messages)) {
    return;
  }
  for (const message of payload.messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    if (
      record.role === "assistant" &&
      Array.isArray(record.tool_calls) &&
      record.tool_calls.length > 0 &&
      !("reasoning_content" in record)
    ) {
      record.reasoning_content = "";
    }
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

function enforceQwenTokenPlanPayloadAfterCaller(
  payload: Record<string, unknown>,
  tokenPlanContract: QwenTokenPlanThinkingContract | undefined,
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
  if (!forceThinking && rawThinkingLevel === "off") {
    enableThinking = false;
  }
  payload.enable_thinking = enableThinking;
  enableThinking = normalizeTokenPlanThinkingToolChoice(payload, enableThinking, forceThinking);
  if (tokenPlanContract?.family === "deepseek-v4") {
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
      const thinkingLevel =
        typeof rawThinkingLevel === "string"
          ? resolveQwenThinkingLevel(rawThinkingLevel as QwenThinkingLevel, undefined)
          : undefined;
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

function finalizeQwenTokenPlanPayloadAfterCaller(
  value: unknown,
  fallbackPayload: Record<string, unknown> | undefined,
  tokenPlanContract: QwenTokenPlanThinkingContract | undefined,
  forceThinking: boolean,
  requestedEnableThinking: boolean,
  requestedThinkingLevel: QwenThinkingLevel,
): unknown {
  const finalPayload = asPayloadRecord(value) ?? fallbackPayload;
  if (finalPayload) {
    enforceQwenTokenPlanPayloadAfterCaller(
      finalPayload,
      tokenPlanContract,
      forceThinking,
      requestedEnableThinking,
      requestedThinkingLevel,
    );
  }
  return value;
}

function createQwenTokenPlanConstraintWrapper(
  baseStreamFn: StreamFn | undefined,
  tokenPlanContract: QwenTokenPlanThinkingContract | undefined,
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
            finalizeQwenTokenPlanPayloadAfterCaller(
              resolved,
              payloadObj,
              tokenPlanContract,
              forceThinking,
              requestedEnableThinking,
              requestedThinkingLevel,
            ),
          );
        }
        return finalizeQwenTokenPlanPayloadAfterCaller(
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

function isQwenOAuthProviderId(providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  return normalized === "qwen-oauth" || normalized === "qwen-portal" || normalized === "qwen-cli";
}

function normalizeQwenOAuthContent(content: unknown): unknown {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return content;
  }
  const normalized = content
    .map((part) => {
      if (typeof part === "string") {
        return { type: "text", text: part };
      }
      return part && typeof part === "object" ? part : undefined;
    })
    .filter((part): part is Record<string, unknown> => Boolean(part));
  return normalized.length > 0 ? normalized : content;
}

function patchQwenOAuthPayload(payload: Record<string, unknown>): void {
  const messages = payload.messages;
  if (!Array.isArray(messages)) {
    return;
  }
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    record.content = normalizeQwenOAuthContent(record.content);
    if (record.role !== "system" || !Array.isArray(record.content) || record.content.length === 0) {
      continue;
    }
    const last = record.content[record.content.length - 1];
    if (last && typeof last === "object") {
      (last as Record<string, unknown>).cache_control = { type: "ephemeral" };
    }
  }
  payload.vl_high_resolution_images = true;
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
  tokenPlanContract?: QwenTokenPlanThinkingContract,
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
      if (tokenPlanContract?.family === "deepseek-v4") {
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
    : resolveQwenTokenPlanThinkingContract(ctx.provider, ctx.modelId);
  const tokenPlanProvider = isQwenTokenPlanProviderId(ctx.provider);
  const tokenPlanModel =
    tokenPlanProvider && isQwenTokenPlanModelId(ctx.modelId) && !explicitLegacyThinkingFormat;
  const forceThinking = tokenPlanModel && isQwenTokenPlanThinkingOnlyModelId(ctx.modelId);
  let streamFn = createQwenThinkingWrapper(
    ctx.streamFn,
    ctx.thinkingLevel,
    thinkingFormat,
    forceThinking,
    tokenPlanContract,
  );
  if (tokenPlanModel) {
    // Config and request extra_body hooks run outside plugin wrappers. Reapply
    // model wire constraints after those hooks so invalid fields cannot escape.
    streamFn = createQwenTokenPlanConstraintWrapper(
      streamFn,
      tokenPlanContract,
      forceThinking,
      ctx.thinkingLevel,
    );
  }
  if (!isQwenOAuthProviderId(ctx.provider)) {
    return streamFn;
  }
  return createPayloadPatchStreamWrapper(streamFn, ({ payload, model }) => {
    if (model.api === "openai-completions") {
      patchQwenOAuthPayload(payload);
    }
  });
}
