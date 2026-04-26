import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildAzureSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "azure-speech",
  name: "Azure Speech",
  description: "Bundled Azure Speech provider",
  register(api) {
    api.registerSpeechProvider(buildAzureSpeechProvider());
  },
});
