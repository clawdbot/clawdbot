import type { PluginCapabilityCatalogEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildOpenAIRealtimeTranscriptionProvider } from "./realtime-transcription-provider-factory.js";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider-factory.js";
import { buildOpenAISpeechProvider } from "./speech-provider.js";

const catalog: PluginCapabilityCatalogEntry = (context) => ({
  speechProviders: [buildOpenAISpeechProvider()],
  realtimeTranscriptionProviders: [buildOpenAIRealtimeTranscriptionProvider(context)],
  realtimeVoiceProviders: [buildOpenAIRealtimeVoiceProvider(context)],
});

export default catalog;
