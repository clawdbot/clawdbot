import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { deepgramMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { buildDeepgramRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

export default definePluginEntry({
  id: "deepgram",
  name: "Deepgram Media Understanding",
  description: "Bundled Deepgram audio transcription provider",
  register(api) {
    api.registerMediaUnderstandingProvider(deepgramMediaUnderstandingProvider);
    api.registerRealtimeTranscriptionProvider(buildDeepgramRealtimeTranscriptionProvider());
  },
});
