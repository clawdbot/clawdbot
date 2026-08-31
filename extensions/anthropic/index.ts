/**
 * Anthropic provider plugin entry. It registers Claude API auth, Claude CLI
 * backend support, native session catalogs, media understanding, stream
 * wrappers, and usage reporting.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerAnthropicPlugin } from "./register.runtime.js";

/** Provider entry for Anthropic API, Claude CLI, and native session surfaces. */
export default definePluginEntry({
  id: "anthropic",
  name: "Anthropic",
  description: "Anthropic models, Claude CLI, and native Claude session catalog",
  register(api) {
    return registerAnthropicPlugin(api);
  },
});
