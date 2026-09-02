/**
 * Lightweight Anthropic setup entry. It registers Claude CLI backend metadata
 * without loading full provider runtime code.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildAnthropicCliBackend } from "./cli-backend.js";

/** Setup entry for Claude CLI backend registration. */
export default definePluginEntry({
  id: "anthropic",
  name: "Anthropic Setup",
  description: "Lightweight Anthropic setup hooks",
  register(api) {
    api.registerCliBackend(buildAnthropicCliBackend());
  },
});
