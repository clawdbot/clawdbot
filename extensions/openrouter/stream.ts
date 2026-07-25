// Openrouter plugin module implements stream behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { isOpenRouterDeepSeekV4ModelId } from "./models.js";
import {
  isOpenRouterProxyReasoningUnsupportedModel,
  normalizeOpenRouterBaseUrl,
  OPENROUTER_BASE_URL,
} from "./provider-catalog.js";

const log = createSubsystemLogger("openrouter-stream");
const openRouterThinkingStreamHooks = buildProviderStreamFamilyHooks("openrouter-thinking");

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function isOpenRouterAnthropicModelId(modelId: unknown): boolean {
  const normalized = readString(modelId)?.toLowerCase();
  return (
    normalized?.startsWith("anthropic/") === true ||
    normalized?.startsWith("openrouter/anthropic/") === true
  );
}

function isVerifiedOpenRouterRoute(model: Parameters<StreamFn>[0]): boolean {
  const provider = readString(model.provider)?.toLowerCase();
  const baseUrl = readString(model.baseUrl);
  if (baseUrl) {
    return normalizeOpenRouterBaseUrl(baseUrl) === OPENROUTER_BASE_URL;
  }
  return provider === "openrouter";
}

function shouldPatchAnthropicOpenRouterPayload(model: Parameters<StreamFn>[0]): boolean {
  const api = readString(model.api);
  return (
    (api === undefined || api === "openai-completions") &&
    isOpenRouterAnthropicModelId(model.id) &&
    isVerifiedOpenRouterRoute(model)
  );
}

function shouldPatchDeepSeekV4OpenRouterPayload(model: Parameters<StreamFn>[0]): boolean {
  const api = readString(model.api);
  return (
    (api === undefined || api === "openai-completions") &&
    isOpenRouterDeepSeekV4ModelId(model.id) &&
    isVerifiedOpenRouterRoute(model)
  );
}

function shouldPatchOpenRouterRoutingPayload(model: Parameters<StreamFn>[0]): boolean {
  const api = readString(model.api);
  return (api === undefined || api === "openai-completions") && isVerifiedOpenRouterRoute(model);
}

function mergeOpenRouterAuthHeaders(options: Parameters<StreamFn>[2]): Parameters<StreamFn>[2] {
  const apiKey = readString(options?.apiKey);
  if (!apiKey) {
    return options;
  }
  const headers = new Headers((options as { headers?: HeadersInit } | undefined)?.headers);
  if (!headers.has("authorization")) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  if (!headers.has("http-referer")) {
    headers.set("HTTP-Referer", "https://openclaw.ai");
  }
  if (!headers.has("x-openrouter-title")) {
    headers.set("X-OpenRouter-Title", "OpenClaw");
  }
  return {
    ...options,
    headers: Object.fromEntries(headers.entries()),
  } as Parameters<StreamFn>[2];
}

function createOpenRouterAuthHeaderWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn | undefined {
  if (!baseStreamFn) {
    return baseStreamFn;
  }
  return (model, context, options) =>
    baseStreamFn(
      model,
      context,
      isVerifiedOpenRouterRoute(model) ? mergeOpenRouterAuthHeaders(options) : options,
    );
}

function assistantMessageHasOpenAIToolCalls(message: Record<string, unknown>): boolean {
  return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

function isAnthropicToolCallContentBlock(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    ((value as { type?: unknown }).type === "tool_use" ||
      (value as { type?: unknown }).type === "toolCall")
  );
}

function assistantMessageHasAnthropicToolUse(message: Record<string, unknown>): boolean {
  const content = message.content;
  return Array.isArray(content) && content.some(isAnthropicToolCallContentBlock);
}

function shouldStripOpenRouterTrailingMessage(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const message = value as Record<string, unknown>;
  return (
    message.role === "assistant" &&
    !assistantMessageHasOpenAIToolCalls(message) &&
    !assistantMessageHasAnthropicToolUse(message)
  );
}

function stripTrailingOpenRouterAssistantPrefillMessages(payload: Record<string, unknown>): number {
  const messages = payload.messages;
  if (!Array.isArray(messages)) {
    return 0;
  }

  let keep = messages.length;
  while (keep > 0 && shouldStripOpenRouterTrailingMessage(messages[keep - 1])) {
    keep -= 1;
  }
  if (keep === messages.length) {
    return 0;
  }
  const stripped = messages.length - keep;
  messages.splice(keep);
  return stripped;
}

function isEnabledReasoningValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false) {
    return false;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized !== "" && normalized !== "off" && normalized !== "none";
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const effort = (value as Record<string, unknown>).effort;
    if (typeof effort === "string") {
      const normalized = effort.trim().toLowerCase();
      return normalized !== "" && normalized !== "off" && normalized !== "none";
    }
  }
  return true;
}

function isOpenRouterReasoningPayloadEnabled(payload: Record<string, unknown>): boolean {
  return (
    isEnabledReasoningValue(payload.reasoning) || isEnabledReasoningValue(payload.reasoning_effort)
  );
}

function stripOpenRouterDeepSeekV4ReasoningContent(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.messages)) {
    return;
  }
  for (const message of payload.messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    delete (message as Record<string, unknown>).reasoning_content;
  }
}

function backfillOpenRouterDeepSeekV4ReasoningContent(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.messages)) {
    return;
  }
  for (const message of payload.messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    if (
      record.role === "assistant" &&
      !assistantMessageHasOpenAIToolCalls(record) &&
      !("reasoning_content" in record)
    ) {
      record.reasoning_content = "";
    }
  }
}

function injectOpenRouterRouting(
  baseStreamFn: StreamFn | undefined,
  providerRouting?: Record<string, unknown>,
): StreamFn | undefined {
  if (!providerRouting) {
    return baseStreamFn;
  }
  const routedStreamFn: StreamFn = (model, context, options) =>
    (
      baseStreamFn ??
      ((nextModel) => {
        throw new Error(
          `OpenRouter routing wrapper requires an underlying streamFn for ${nextModel.id}.`,
        );
      })
    )(
      {
        ...model,
        compat: { ...model.compat, openRouterRouting: providerRouting },
      } as typeof model,
      context,
      options,
    );
  return createPayloadPatchStreamWrapper(
    routedStreamFn,
    ({ payload }) => {
      if (payload.provider === undefined) {
        payload.provider = providerRouting;
      }
    },
    {
      shouldPatch: ({ model }) => shouldPatchOpenRouterRoutingPayload(model),
    },
  );
}

function createOpenRouterAnthropicPrefillWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  return createPayloadPatchStreamWrapper(
    baseStreamFn,
    ({ payload }) => {
      if (!isOpenRouterReasoningPayloadEnabled(payload)) {
        return;
      }
      const stripped = stripTrailingOpenRouterAssistantPrefillMessages(payload);
      if (stripped > 0) {
        log.warn(
          `removed ${stripped} trailing assistant prefill message${stripped === 1 ? "" : "s"} because OpenRouter-routed Anthropic reasoning requires conversations to end with a user turn`,
        );
      }
    },
    {
      shouldPatch: ({ model }) => shouldPatchAnthropicOpenRouterPayload(model),
    },
  );
}

function resolveOpenRouterDeepSeekV4ReasoningEffort(
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): "high" | "xhigh" | undefined {
  if (thinkingLevel === "off") {
    return undefined;
  }
  if (thinkingLevel === "xhigh" || thinkingLevel === "max") {
    return "xhigh";
  }
  return "high";
}

function applyOpenRouterDeepSeekV4ReasoningEffort(
  payload: Record<string, unknown>,
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): boolean {
  const effort = resolveOpenRouterDeepSeekV4ReasoningEffort(thinkingLevel);
  if (!effort) {
    delete payload.reasoning;
    return false;
  }
  const reasoning =
    payload.reasoning && typeof payload.reasoning === "object" && !Array.isArray(payload.reasoning)
      ? (payload.reasoning as Record<string, unknown>)
      : {};
  reasoning.effort = effort;
  payload.reasoning = reasoning;
  return true;
}

function createOpenRouterDeepSeekV4ReplayWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): StreamFn {
  return createPayloadPatchStreamWrapper(
    baseStreamFn,
    ({ payload }) => {
      delete payload.thinking;
      delete payload.reasoning_effort;
      if (!applyOpenRouterDeepSeekV4ReasoningEffort(payload, thinkingLevel)) {
        stripOpenRouterDeepSeekV4ReasoningContent(payload);
        return;
      }
      backfillOpenRouterDeepSeekV4ReasoningContent(payload);
    },
    {
      shouldPatch: ({ model }) => shouldPatchDeepSeekV4OpenRouterPayload(model),
    },
  );
}

export function wrapOpenRouterProviderStream(
  ctx: ProviderWrapStreamFnContext,
): StreamFn | null | undefined {
  const providerRouting =
    ctx.extraParams?.provider != null && typeof ctx.extraParams.provider === "object"
      ? (ctx.extraParams.provider as Record<string, unknown>)
      : undefined;
  const routedStreamFn = providerRouting
    ? injectOpenRouterRouting(ctx.streamFn, providerRouting)
    : ctx.streamFn;
  const wrapStreamFn = openRouterThinkingStreamHooks.wrapStreamFn ?? undefined;
  if (!wrapStreamFn) {
    return createOpenRouterAnthropicPrefillWrapper(
      createOpenRouterAuthHeaderWrapper(
        createOpenRouterDeepSeekV4ReplayWrapper(routedStreamFn, ctx.thinkingLevel),
      ),
    );
  }
  const wrappedStreamFn =
    wrapStreamFn({
      ...ctx,
      streamFn: routedStreamFn,
      thinkingLevel: isOpenRouterProxyReasoningUnsupportedModel(ctx.modelId)
        ? undefined
        : ctx.thinkingLevel,
    }) ?? undefined;
  return createOpenRouterAnthropicPrefillWrapper(
    createOpenRouterAuthHeaderWrapper(
      createOpenRouterDeepSeekV4ReplayWrapper(wrappedStreamFn, ctx.thinkingLevel),
    ),
  );
}
