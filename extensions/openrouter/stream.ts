import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { OPENROUTER_THINKING_STREAM_HOOKS } from "openclaw/plugin-sdk/provider-stream-family";
import {
  createPayloadPatchStreamWrapper,
  stripTrailingAssistantPrefillMessages,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  isOpenRouterProxyReasoningUnsupportedModel,
  normalizeOpenRouterBaseUrl,
  OPENROUTER_BASE_URL,
} from "./provider-catalog.js";

const log = createSubsystemLogger("openrouter-stream");

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

function isEnabledReasoningValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false) {
    return false;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized !== "" && normalized !== "off" && normalized !== "none";
  }
  return true;
}

function isOpenRouterReasoningPayloadEnabled(payload: Record<string, unknown>): boolean {
  return (
    isEnabledReasoningValue(payload.reasoning) || isEnabledReasoningValue(payload.reasoning_effort)
  );
}

function injectOpenRouterRouting(
  baseStreamFn: StreamFn | undefined,
  providerRouting?: Record<string, unknown>,
): StreamFn | undefined {
  if (!providerRouting) {
    return baseStreamFn;
  }
  return (model, context, options) =>
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
}

function createOpenRouterAnthropicPrefillWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  return createPayloadPatchStreamWrapper(
    baseStreamFn,
    ({ payload }) => {
      if (!isOpenRouterReasoningPayloadEnabled(payload)) {
        return;
      }
      const stripped = stripTrailingAssistantPrefillMessages(payload);
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
  const wrapStreamFn = OPENROUTER_THINKING_STREAM_HOOKS.wrapStreamFn ?? undefined;
  if (!wrapStreamFn) {
    return createOpenRouterAnthropicPrefillWrapper(routedStreamFn);
  }
  const wrappedStreamFn =
    wrapStreamFn({
      ...ctx,
      streamFn: routedStreamFn,
      thinkingLevel: isOpenRouterProxyReasoningUnsupportedModel(ctx.modelId)
        ? undefined
        : ctx.thinkingLevel,
    }) ?? undefined;
  return createOpenRouterAnthropicPrefillWrapper(wrappedStreamFn);
}

export const __testing = {
  isOpenRouterAnthropicModelId,
  isOpenRouterReasoningPayloadEnabled,
  isVerifiedOpenRouterRoute,
  shouldPatchAnthropicOpenRouterPayload,
};
