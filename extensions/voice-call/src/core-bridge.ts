// Voice Call plugin module implements core bridge behavior.
import type { OpenClawPluginApi } from "../api.js";
import type { VoiceCallTtsConfig } from "./config.js";

// Narrow core runtime/config contracts consumed by the voice-call plugin.

/** Core config subset read by voice-call helpers. */
export type CoreConfig = {
  session?: {
    store?: string;
  };
  messages?: {
    tts?: VoiceCallTtsConfig;
  };
  [key: string]: unknown;
};

/** Agent runtime API subset exposed through the plugin SDK. */
export type CoreAgentDeps = OpenClawPluginApi["runtime"]["agent"];
