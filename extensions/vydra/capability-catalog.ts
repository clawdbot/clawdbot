import type { PluginCapabilityCatalog } from "openclaw/plugin-sdk/plugin-entry";
import { buildVydraSpeechProvider } from "./speech-provider.js";

export default {
  speechProviders: [buildVydraSpeechProvider()],
} satisfies PluginCapabilityCatalog;
