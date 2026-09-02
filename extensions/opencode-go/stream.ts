// Opencode Go plugin module implements stream behavior.
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
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
