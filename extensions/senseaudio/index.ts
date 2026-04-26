import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { senseaudioMediaUnderstandingProvider } from "./media-understanding-provider.js";

export default definePluginEntry({
  id: "senseaudio",
  name: "SenseAudio",
  description: "Bundled SenseAudio audio transcription provider",
  register(api) {
    api.registerMediaUnderstandingProvider(senseaudioMediaUnderstandingProvider);
  },
});
