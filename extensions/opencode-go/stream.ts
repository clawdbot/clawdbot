// Opencode Go plugin module implements stream behavior.
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { resolveProviderRequestHeaders } from "openclaw/plugin-sdk/provider-http";
import {
  composeProviderStreamWrappers,
  createDeepSeekV4OpenAICompatibleThinkingWrapper,
  createOpenAICompatibleCompletionsThinkingOffWrapper,
  createPayloadPatchStreamWrapper,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { isOpencodeGoKimiNoReasoningModelId } from "./provider-catalog.js";
import { isOpencodeGoFixedAnthropicReasoningModelId } from "./provider-policy-api.js";
import { stripOpencodeGoKimiReasoningPayload } from "./reasoning-sanitizer.js";
import {
  createOpencodeGoStalledStreamWrapper,
  OPENCODE_GO_STREAM_FIRST_EVENT_TIMEOUT_MS_DEFAULT,
  OPENCODE_GO_STREAM_IDLE_TIMEOUT_MS_DEFAULT,
} from "./stream-termination.js";

export function createOpencodeGoAttributionWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  sourceApi?: ProviderWrapStreamFnContext["sourceApi"],
): ProviderWrapStreamFnContext["streamFn"] {
  if (!baseStreamFn) {
    return undefined;
  }
  return (model, context, options) => {
    const api = sourceApi ?? model.api;
    // OpenAI transports already consume the central policy; Anthropic does not.
    // Keep this narrow so each request resolves attribution exactly once.
    if (model.provider !== "opencode-go" || api !== "anthropic-messages") {
      return baseStreamFn(model, context, options);
    }
    return baseStreamFn(model, context, {
      ...options,
      headers: resolveProviderRequestHeaders({
        provider: model.provider,
        api,
        baseUrl: model.baseUrl,
        capability: "llm",
        transport: "stream",
        callerHeaders: options?.headers,
        precedence: "defaults-win",
      }),
    });
  };
}

export function createOpencodeGoWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): ProviderWrapStreamFnContext["streamFn"] {
  if (!baseStreamFn) {
    return undefined;
  }
  const wrapped =
    composeProviderStreamWrappers(
      baseStreamFn,
      (streamFn) =>
        streamFn
          ? createPayloadPatchStreamWrapper(
              streamFn,
              ({ payload }) => stripOpencodeGoKimiReasoningPayload(payload),
              {
                shouldPatch: ({ model }) =>
                  model.provider === "opencode-go" && isOpencodeGoKimiNoReasoningModelId(model.id),
              },
            )
          : undefined,
      (streamFn) => {
        if (!streamFn) {
          return undefined;
        }
        const thinkingOff = createOpenAICompatibleCompletionsThinkingOffWrapper(
          streamFn,
          thinkingLevel,
        );
        return (model, context, options) =>
          model.provider === "opencode-go" && model.id === "kimi-k3"
            ? thinkingOff(model, context, options)
            : streamFn(model, context, options);
      },
      (streamFn) =>
        streamFn
          ? createPayloadPatchStreamWrapper(
              streamFn,
              ({ payload }) => {
                delete payload.thinking;
                delete payload.output_config;
              },
              {
                shouldPatch: ({ model }) =>
                  model.provider === "opencode-go" &&
                  isOpencodeGoFixedAnthropicReasoningModelId(model.id),
              },
            )
          : undefined,
      (streamFn) =>
        createDeepSeekV4OpenAICompatibleThinkingWrapper({
          baseStreamFn: streamFn,
          thinkingLevel,
          shouldPatchModel: (model) =>
            model.provider === "opencode-go" && model.id === "deepseek-v4-flash",
          resolveReasoningEffort: (level) =>
            level === "low" ? "low" : level === "max" ? "max" : "high",
        }) ?? streamFn,
      (streamFn) =>
        createDeepSeekV4OpenAICompatibleThinkingWrapper({
          baseStreamFn: streamFn,
          thinkingLevel,
          shouldPatchModel: (model) =>
            model.provider === "opencode-go" && model.id === "deepseek-v4-pro",
        }) ?? streamFn,
      createOpencodeGoAttributionWrapper,
    ) ?? baseStreamFn;
  // Outermost layer: provider-owned stalled SSE termination so the underlying
  // OpenAI SDK request is aborted at the raw opencode-go boundary instead of
  // waiting for the shared runtime stuck-session recovery.
  return createOpencodeGoStalledStreamWrapper(wrapped, {
    provider: "opencode-go",
    idleTimeoutMs: OPENCODE_GO_STREAM_IDLE_TIMEOUT_MS_DEFAULT,
    firstEventTimeoutMs: OPENCODE_GO_STREAM_FIRST_EVENT_TIMEOUT_MS_DEFAULT,
  });
}
