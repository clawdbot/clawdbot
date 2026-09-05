import type { PluginCapabilityCatalog } from "openclaw/plugin-sdk/plugin-entry";
import { buildAzureSpeechProvider } from "./speech-provider.js";

export default {
  speechProviders: [buildAzureSpeechProvider()],
} satisfies PluginCapabilityCatalog;
