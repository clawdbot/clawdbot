import type { PluginCapabilityCatalogEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  createLazyXaiSpeechProvider,
  createLazyXaiRealtimeTranscriptionProvider,
  createLazyXaiRealtimeVoiceProvider,
} from "./lazy-capability-provider-factories.js";

const catalog: PluginCapabilityCatalogEntry = (context) => ({
  speechProviders: [createLazyXaiSpeechProvider(context)],
  realtimeTranscriptionProviders: [createLazyXaiRealtimeTranscriptionProvider(context)],
  realtimeVoiceProviders: [createLazyXaiRealtimeVoiceProvider(context)],
});

export default catalog;
