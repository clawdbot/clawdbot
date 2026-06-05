/**
 * Anthropic provider plugin entry. It registers Claude API auth, Claude CLI
 * backend support, media understanding, stream wrappers, and usage reporting.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerAnthropicPlugin } from "./register.runtime.js";

/** Provider entry for Anthropic API and Claude CLI runtime surfaces. */
export default definePluginEntry({
  id: "anthropic",
  name: "Anthropic Provider",
  description: "Bundled Anthropic provider plugin",
  register(api) {
    return registerAnthropicPlugin(api);
  },
});
