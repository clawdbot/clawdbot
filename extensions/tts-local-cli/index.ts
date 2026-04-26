import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildCliSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "tts-local-cli",
  name: "Local CLI TTS",
  description: "Bundled CLI speech provider for local TTS",
  register(api) {
    api.registerSpeechProvider(buildCliSpeechProvider());
  },
});
