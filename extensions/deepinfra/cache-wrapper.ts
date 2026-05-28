import {
  applyAnthropicEphemeralCacheControlMarkers,
  streamWithPayloadPatch,
} from "openclaw/plugin-sdk/provider-stream";

// StreamFn isn't re-exported via the plugin SDK; derive it from a helper that
// accepts it so we stay on the SDK boundary.
type StreamFn = Parameters<typeof streamWithPayloadPatch>[0];

// Inject Anthropic ephemeral cache_control markers for anthropic/* models on
// DeepInfra. The OpenRouter equivalent short-circuits on a provider/endpoint
// check, so DeepInfra advertises isCacheTtlEligible but the payload patch
// never fires. Gating on the model id instead fixes that.
export function createDeepInfraAnthropicCacheWrapper(baseStreamFn: StreamFn): StreamFn {
  return ((model, context, options) => {
    const modelIdRaw = (model as { id?: unknown }).id;
    const modelId = typeof modelIdRaw === "string" ? modelIdRaw.toLowerCase() : "";
    if (!modelId.startsWith("anthropic/")) {
      return baseStreamFn(model, context, options);
    }
    return streamWithPayloadPatch(baseStreamFn, model, context, options, (payload) => {
      applyAnthropicEphemeralCacheControlMarkers(payload);
    });
  }) as StreamFn;
}
