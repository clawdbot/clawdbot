import type { PluginCapabilityCatalog } from "openclaw/plugin-sdk/plugin-entry";
import { buildMicrosoftSpeechProvider } from "./speech-provider.js";

export default {
  speechProviders: [buildMicrosoftSpeechProvider()],
} satisfies PluginCapabilityCatalog;
