import type { PluginCapabilityCatalog } from "openclaw/plugin-sdk/plugin-entry";
import { buildOpenRouterSpeechProvider } from "./speech-provider.js";

export default {
  speechProviders: [buildOpenRouterSpeechProvider()],
} satisfies PluginCapabilityCatalog;
