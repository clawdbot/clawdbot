import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildOpenAICodexCliBackend } from "./cli-backend.js";

export default definePluginEntry({
  id: "openai",
  name: "OpenAI Setup",
  description: "Lightweight OpenAI setup hooks",
  register(api) {
    api.registerCliBackend(buildOpenAICodexCliBackend());
  },
});
