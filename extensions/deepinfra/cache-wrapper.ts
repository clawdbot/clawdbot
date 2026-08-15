// Deepinfra plugin module implements cache wrapper behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  applyAnthropicEphemeralCacheControlMarkers,
  createPayloadPatchStreamWrapper,
} from "openclaw/plugin-sdk/provider-stream-shared";

// Inject Anthropic ephemeral cache_control markers for anthropic/* models on
// DeepInfra. The OpenRouter equivalent short-circuits on a provider/endpoint
// check, so DeepInfra advertises isCacheTtlEligible but the payload patch
// never fires. Gating on the model id instead fixes that.
export function createDeepInfraAnthropicCacheWrapper(baseStreamFn: StreamFn): StreamFn {
  return createPayloadPatchStreamWrapper(
    baseStreamFn,
    ({ payload }) => {
      applyAnthropicEphemeralCacheControlMarkers(payload);
    },
    {
      shouldPatch: ({ model }) => model.id.toLowerCase().startsWith("anthropic/"),
    },
  );
}
