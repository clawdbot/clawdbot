import { resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import {
  isProviderAuthProfileConfigured,
  isProviderApiKeyConfigured,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { createRealtimeTranscriptionWebSocketSession } from "openclaw/plugin-sdk/realtime-transcription-session";
import {
  createLazyXaiSpeechProvider as createLazyXaiSpeechProviderCore,
  createLazyXaiRealtimeTranscriptionProvider as createLazyXaiRealtimeTranscriptionProviderCore,
  createLazyXaiRealtimeVoiceProvider as createLazyXaiRealtimeVoiceProviderCore,
  createLazyXaiVideoGenerationProvider as createLazyXaiVideoGenerationProviderCore,
} from "./lazy-capability-provider-factories.js";

export {
  createLazyXaiImageGenerationProvider,
  createLazyXaiMediaUnderstandingProvider,
} from "./lazy-capability-provider-factories.js";
export function createLazyXaiSpeechProvider() {
  return createLazyXaiSpeechProviderCore({ isProviderAuthProfileConfigured });
}
export function createLazyXaiRealtimeTranscriptionProvider() {
  return createLazyXaiRealtimeTranscriptionProviderCore({
    isProviderAuthProfileConfigured,
    resolveApiKeyForProvider,
    createRealtimeTranscriptionWebSocketSession,
  });
}
export function createLazyXaiRealtimeVoiceProvider() {
  return createLazyXaiRealtimeVoiceProviderCore({
    isProviderAuthProfileConfigured,
    resolveAgentDir,
  });
}
export function createLazyXaiVideoGenerationProvider() {
  return createLazyXaiVideoGenerationProviderCore({ isProviderApiKeyConfigured });
}
