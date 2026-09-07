// Capability catalog for the OpenAI-compatible realtime transcription provider.
// Declares one provider under the `realtimeTranscriptionProviders` family; the
// OpenClaw runtime loads the catalog entry and registers the providers it
// returns without invoking the plugin `index.ts` `register()` body. This keeps
// our surface narrow ÔÇö we only ship a single provider, no setup hooks, no
// dashboard tabs.
import type {
  PluginCapabilityCatalog,
  PluginCapabilityCatalogContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildOpenAiCompatibleRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

const catalog = (context: PluginCapabilityCatalogContext): PluginCapabilityCatalog => ({
  realtimeTranscriptionProviders: [
    buildOpenAiCompatibleRealtimeTranscriptionProvider({
      createRealtimeTranscriptionWebSocketSession:
        context.createRealtimeTranscriptionWebSocketSession,
    }),
  ],
});

export default catalog;
