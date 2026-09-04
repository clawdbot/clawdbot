import { isProviderAuthProfileConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { createRealtimeTranscriptionWebSocketSession } from "openclaw/plugin-sdk/realtime-transcription-session";
import { buildXaiRealtimeTranscriptionProvider as createProvider } from "./realtime-transcription-provider-factory.js";

export function buildXaiRealtimeTranscriptionProvider() {
  return createProvider({
    isProviderAuthProfileConfigured,
    resolveApiKeyForProvider,
    createRealtimeTranscriptionWebSocketSession,
  });
}
