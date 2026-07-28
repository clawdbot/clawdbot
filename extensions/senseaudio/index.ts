// Senseaudio plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { senseaudioMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { createSenseAudioWebSearchProvider } from "./src/senseaudio-web-search-provider.js";

export default definePluginEntry({
  id: "senseaudio",
  name: "SenseAudio",
  description: "Bundled SenseAudio audio transcription and web search provider",
  register(api) {
    api.registerMediaUnderstandingProvider(senseaudioMediaUnderstandingProvider);
    api.registerWebSearchProvider(createSenseAudioWebSearchProvider());
  },
});
