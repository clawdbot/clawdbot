import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "web-readability",
  name: "Web Readability Extraction",
  description: "Extract readable article content from local HTML web fetch responses.",
  register() {
    // Runtime is exposed through web-content-extractor.ts so hot web-fetch paths can
    // load only the narrow extractor artifact instead of the full plugin entrypoint.
  },
});
