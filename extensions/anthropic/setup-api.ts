import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildAnthropicCliBackend } from "./cli-backend.js";

export default definePluginEntry({
  id: "anthropic",
  name: "Anthropic Setup",
  description: "Lightweight Anthropic setup hooks",
  register(api) {
    api.registerCliBackend(buildAnthropicCliBackend());
  },
});
