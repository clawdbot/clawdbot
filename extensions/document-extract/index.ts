import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "document-extract",
  name: "Document Extraction",
  description: "Extract text and fallback page images from local document attachments.",
  register() {
    // Runtime is exposed through document-extractor.ts so document hot paths can
    // load only the narrow extractor artifact instead of the full plugin entrypoint.
  },
});
