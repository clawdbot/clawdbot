// Opencode Go plugin module implements stream behavior.
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
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

function createOpencodeGoDeepSeekV4Wrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): ProviderWrapStreamFnContext["streamFn"] {
  const flashWrapped = createDeepSeekV4OpenAICompatibleThinkingWrapper({
    baseStreamFn,
    thinkingLevel,
    shouldPatchModel: (model) =>
      model.provider === "opencode-go" && model.id === "deepseek-v4-flash",
    resolveReasoningEffort: (level) => (level === "low" ? "low" : level === "max" ? "max" : "high"),
  });
  return createDeepSeekV4OpenAICompatibleThinkingWrapper({
    baseStreamFn: flashWrapped,
    thinkingLevel,
    shouldPatchModel: (model) => model.provider === "opencode-go" && model.id === "deepseek-v4-pro",
  });
}

function createOpencodeGoKimiNoReasoningWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
): ProviderWrapStreamFnContext["streamFn"] {
  if (!baseStreamFn) {
    return undefined;
  }
  return createPayloadPatchStreamWrapper(
    baseStreamFn,
    ({ payload }) => stripOpencodeGoKimiReasoningPayload(payload),
    {
      shouldPatch: ({ model }) =>
        model.provider === "opencode-go" && isOpencodeGoKimiNoReasoningModelId(model.id),
    },
  );
}

function createOpencodeGoFixedAnthropicReasoningWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
): ProviderWrapStreamFnContext["streamFn"] {
  if (!baseStreamFn) {
    return undefined;
  }
  return createPayloadPatchStreamWrapper(
    baseStreamFn,
    ({ payload }) => {
      delete payload.thinking;
      delete payload.output_config;
    },
    {
      shouldPatch: ({ model }) =>
        model.provider === "opencode-go" && isOpencodeGoFixedAnthropicReasoningModelId(model.id),
    },
  );
}

function createOpencodeGoKimiK3ThinkingOffWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): ProviderWrapStreamFnContext["streamFn"] {
  if (!baseStreamFn) {
    return undefined;
  }
  const thinkingOff = createOpenAICompatibleCompletionsThinkingOffWrapper(
    baseStreamFn,
    thinkingLevel,
  );
  return (model, context, options) =>
    model.provider === "opencode-go" && model.id === "kimi-k3"
      ? thinkingOff(model, context, options)
      : baseStreamFn(model, context, options);
}

export function createOpencodeGoWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): ProviderWrapStreamFnContext["streamFn"] {
  if (!baseStreamFn) {
    return undefined;
  }
  const kimiWrapped = createOpencodeGoKimiNoReasoningWrapper(baseStreamFn) ?? baseStreamFn;
  const kimiK3Wrapped =
    createOpencodeGoKimiK3ThinkingOffWrapper(kimiWrapped, thinkingLevel) ?? kimiWrapped;
  const fixedAnthropicWrapped =
    createOpencodeGoFixedAnthropicReasoningWrapper(kimiK3Wrapped) ?? kimiK3Wrapped;
  const deepSeekWrapped =
    createOpencodeGoDeepSeekV4Wrapper(fixedAnthropicWrapped, thinkingLevel) ??
    fixedAnthropicWrapped;
  // Outermost layer: provider-owned stalled SSE termination so the underlying
  // OpenAI SDK request is aborted at the raw opencode-go boundary instead of
  // waiting for the shared runtime stuck-session recovery.
  return createOpencodeGoStalledStreamWrapper(deepSeekWrapped, {
    provider: "opencode-go",
    idleTimeoutMs: OPENCODE_GO_STREAM_IDLE_TIMEOUT_MS_DEFAULT,
    firstEventTimeoutMs: OPENCODE_GO_STREAM_FIRST_EVENT_TIMEOUT_MS_DEFAULT,
  });
}
