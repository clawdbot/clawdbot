// Voice Call plugin module implements cli metadata behavior.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { VOICE_CALL_CLI_DESCRIPTOR } from "./cli-output-mode.js";

// Lightweight CLI metadata entry for exposing the voicecall command.

export default definePluginEntry({
  id: "voice-call",
  name: "Voice Call",
  description: "Voice call channel plugin",
  register(api) {
    api.registerCli(() => {}, {
      commands: ["voicecall"],
      descriptors: [VOICE_CALL_CLI_DESCRIPTOR],
    });
  },
});
