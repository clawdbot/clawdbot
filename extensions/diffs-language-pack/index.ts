// Diffs Language Pack plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "./api.js";
import { registerDiffsLanguagePackPlugin } from "./src/plugin.js";

export default definePluginEntry({
  id: "diffs-language-pack",
  name: "Diff Viewer Language Pack",
  description: "Adds syntax highlighting for languages outside the default diffs viewer set.",
  register: registerDiffsLanguagePackPlugin,
});
