// Document Extract plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "document-extract",
  name: "Document Extraction",
  description:
    "Extract text from local PDF and Office document attachments, with fallback page images for PDFs.",
  register() {
    // Runtime is exposed through document-extractor.ts so document hot paths can
    // load only the narrow extractor artifact instead of the full plugin entrypoint.
  },
});
