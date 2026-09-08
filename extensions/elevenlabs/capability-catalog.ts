import type { PluginCapabilityCatalogEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildElevenLabsRealtimeTranscriptionProvider } from "./realtime-transcription-provider-factory.js";
import { buildElevenLabsSpeechProvider } from "./speech-provider-factory.js";

export default ((context) => ({
  speechProviders: [buildElevenLabsSpeechProvider(context)],
  realtimeTranscriptionProviders: [buildElevenLabsRealtimeTranscriptionProvider(context)],
})) satisfies PluginCapabilityCatalogEntry;
