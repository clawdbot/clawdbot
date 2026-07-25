// Opencode Go plugin module implements stream behavior.
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createDeepSeekV4OpenAICompatibleThinkingWrapper,
  streamWithPayloadPatch,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { isOpencodeGoKimiNoReasoningModelId } from "./provider-catalog.js";
import { isOpencodeGoDeepSeekV4ModelId } from "./provider-policy-api.js";
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
  return createDeepSeekV4OpenAICompatibleThinkingWrapper({
    baseStreamFn,
    thinkingLevel,
    shouldPatchModel: (model) =>
      model.provider === "opencode-go" && isOpencodeGoDeepSeekV4ModelId(model.id),
  });
}

function stripReasoningParams(payloadObj: Record<string, unknown>): void {
  stripOpencodeGoKimiReasoningPayload(payloadObj);
}

function createOpencodeGoKimiNoReasoningWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
): ProviderWrapStreamFnContext["streamFn"] {
  if (!baseStreamFn) {
    return undefined;
  }
  const underlying = baseStreamFn;
  return (model, context, options) => {
    if (model.provider !== "opencode-go" || !isOpencodeGoKimiNoReasoningModelId(model.id)) {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, stripReasoningParams);
  };
}

export function createOpencodeGoWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): ProviderWrapStreamFnContext["streamFn"] {
  if (!baseStreamFn) {
    return undefined;
  }
  const kimiWrapped = createOpencodeGoKimiNoReasoningWrapper(baseStreamFn) ?? baseStreamFn;
  const deepSeekWrapped =
    createOpencodeGoDeepSeekV4Wrapper(kimiWrapped, thinkingLevel) ?? kimiWrapped;
  // Outermost layer: provider-owned stalled SSE termination so the underlying
  // OpenAI SDK request is aborted at the raw opencode-go boundary instead of
  // waiting for the shared runtime stuck-session recovery.
  return createOpencodeGoStalledStreamWrapper(deepSeekWrapped, {
    provider: "opencode-go",
    idleTimeoutMs: OPENCODE_GO_STREAM_IDLE_TIMEOUT_MS_DEFAULT,
    firstEventTimeoutMs: OPENCODE_GO_STREAM_FIRST_EVENT_TIMEOUT_MS_DEFAULT,
  });
}
