import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice";
import {
  assertXaiRealtimeVoiceRequestSupported,
  createXaiRealtimeVoiceProviderMetadata,
} from "./capability-provider-metadata.js";
import { resolveXaiRealtimeApiKey } from "./realtime-voice-auth.runtime.js";
import { XaiRealtimeVoiceBridge } from "./realtime-voice-bridge.js";
import {
  normalizeXaiRealtimeBaseUrl,
  normalizeXaiRealtimeProviderConfig,
} from "./realtime-voice-config.js";

export function buildXaiRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    ...createXaiRealtimeVoiceProviderMetadata(),
    createBridge: (req) => {
      const config = normalizeXaiRealtimeProviderConfig(req.providerConfig);
      assertXaiRealtimeVoiceRequestSupported(req);
      return new XaiRealtimeVoiceBridge({
        ...req,
        apiKey: config.apiKey,
        baseUrl: normalizeXaiRealtimeBaseUrl(config.baseUrl),
        model: config.model,
        voice: config.voice,
        vadThreshold: config.vadThreshold,
        silenceDurationMs: config.silenceDurationMs,
        prefixPaddingMs: config.prefixPaddingMs,
        reasoningEffort: config.reasoningEffort,
        sessionResumption: config.sessionResumption,
        resolveApiKey: () => resolveXaiRealtimeApiKey(config.apiKey, req.cfg, req.agentId),
      });
    },
  };
}
