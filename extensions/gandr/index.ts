// Gandr plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildGandrSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "gandr",
  name: "Gandr Speech",
  description: "Bundled Gandr speech provider",
  register(api) {
    api.registerSpeechProvider(buildGandrSpeechProvider());
  },
});
