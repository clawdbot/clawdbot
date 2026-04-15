import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { deepgramMediaUnderstandingProvider } from "./media-understanding-provider.js";

export default definePluginEntry({
  id: "deepgram",
  name: "Deepgram Media Understanding",
  description: "Bundled Deepgram audio transcription provider",
  register(api) {
    api.registerMediaUnderstandingProvider(deepgramMediaUnderstandingProvider);
  },
});
