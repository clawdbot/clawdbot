import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  applyAnthropicEphemeralCacheControlMarkers,
  applyCompletionsAnthropicCacheControl,
  createPayloadPatchStreamWrapper,
} from "openclaw/plugin-sdk/provider-stream-shared";

export function createDeepInfraAnthropicCacheWrapper(
  baseStreamFn: StreamFn,
  extraParams?: Record<string, unknown>,
): StreamFn {
  return (model, context, options) => {
    if (!model.id.toLowerCase().startsWith("anthropic/")) {
      return baseStreamFn(model, context, options);
    }
    const isCompletions = model.api === "openai-completions";
    const configured = options?.cacheRetention ?? extraParams?.cacheRetention;
    const cacheRetention = configured === "none" || configured === "long" ? configured : "short";
    return createPayloadPatchStreamWrapper(baseStreamFn, ({ payload }) => {
      if (isCompletions) {
        applyCompletionsAnthropicCacheControl(
          payload,
          cacheRetention === "none" ? null : { type: "ephemeral" },
        );
      } else {
        applyAnthropicEphemeralCacheControlMarkers(payload);
      }
    })(model, context, isCompletions ? { ...options, cacheRetention } : options);
  };
}
