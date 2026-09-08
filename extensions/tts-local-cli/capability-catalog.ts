import type { PluginCapabilityCatalog } from "openclaw/plugin-sdk/plugin-entry";
import { buildCliSpeechProvider } from "./speech-provider.js";

export default {
  speechProviders: [buildCliSpeechProvider()],
} satisfies PluginCapabilityCatalog;
