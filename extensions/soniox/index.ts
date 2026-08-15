/**
 * Soniox plugin entry. Registers the Soniox async speech-to-text
 * (media-understanding) provider.
 *
 * Soniox TTS is intentionally excluded from this PR (tracked separately; the
 * TTS implementation is preserved under tta-lab/soniox-tts-backup/).
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { sonioxMediaUnderstandingProvider } from "./media-understanding-provider.js";

/** Plugin entry for Soniox speech-to-text. */
export default definePluginEntry({
  id: "soniox",
  name: "Soniox",
  description: "Bundled Soniox async speech-to-text (media-understanding) provider",
  register(api) {
    api.registerMediaUnderstandingProvider(sonioxMediaUnderstandingProvider);
  },
});
