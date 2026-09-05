import type { PluginCapabilityCatalog } from "openclaw/plugin-sdk/plugin-entry";
import { buildInworldSpeechProvider } from "./speech-provider.js";

export default {
  speechProviders: [buildInworldSpeechProvider()],
} satisfies PluginCapabilityCatalog;
