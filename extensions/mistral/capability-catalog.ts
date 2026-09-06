import type { PluginCapabilityCatalogEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildMistralRealtimeTranscriptionProvider } from "./realtime-transcription-provider-factory.js";

export default ((context) => ({
  realtimeTranscriptionProviders: [buildMistralRealtimeTranscriptionProvider(context)],
})) satisfies PluginCapabilityCatalogEntry;
