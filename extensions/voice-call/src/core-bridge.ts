import type { OpenClawPluginApi } from "../api.js";
import type { VoiceCallTtsConfig } from "./config.js";

export type CoreConfig = {
  session?: {
    store?: string;
  };
  messages?: {
    tts?: VoiceCallTtsConfig;
  };
  [key: string]: unknown;
};

export type CoreAgentDeps = OpenClawPluginApi["runtime"]["agent"];
