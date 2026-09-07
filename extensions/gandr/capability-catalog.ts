import type { PluginCapabilityCatalog } from "openclaw/plugin-sdk/plugin-entry";
import { buildGandrSpeechProvider } from "./speech-provider.js";

export default {
  speechProviders: [buildGandrSpeechProvider()],
} satisfies PluginCapabilityCatalog;
