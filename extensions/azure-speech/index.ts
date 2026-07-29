/**
 * Azure Speech plugin entry. It registers the Azure text-to-speech provider for
 * message voice output and voice-note generation.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildAzureSpeechProvider } from "./speech-provider.js";

/** Plugin entry for Azure Speech TTS. */
export default definePluginEntry({
  id: "azure-speech",
  name: "Azure Speech",
  description: "Bundled Azure Speech provider",
  register(api) {
    api.registerSpeechProvider(buildAzureSpeechProvider());
  },
});
