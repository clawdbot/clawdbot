// Fish Audio plugin entrypoint registers hosted speech synthesis.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildFishAudioSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "fish-audio-speech",
  name: "Fish Audio Speech",
  description: "Hosted Fish Audio S2.1 text-to-speech provider",
  register(api) {
    api.registerSpeechProvider(buildFishAudioSpeechProvider());
  },
});
