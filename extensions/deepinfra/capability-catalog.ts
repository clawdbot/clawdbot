import type { PluginCapabilityCatalog } from "openclaw/plugin-sdk/plugin-entry";
import { buildDeepInfraSpeechProvider } from "./speech-provider.js";

export default {
  speechProviders: [buildDeepInfraSpeechProvider()],
} satisfies PluginCapabilityCatalog;
