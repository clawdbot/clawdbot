/**
 * Extract audio mode tag from text.
 * Supports [[audio_as_voice]] to send audio as voice bubble instead of file.
 * Default is file (preserves backward compatibility).
 */
export function extractAudioTag(text?: string): {
  cleaned: string;
  audioAsVoice: boolean;
  hasTag: boolean;
} {
  if (!text) return { cleaned: "", audioAsVoice: false, hasTag: false };
  let cleaned = text;
  let audioAsVoice = false; // default: audio file (backward compatible)
  let hasTag = false;

  // [[audio_as_voice]] -> send as voice bubble (opt-in)
  const voiceMatch = cleaned.match(/\[\[audio_as_voice\]\]/i);
  if (voiceMatch) {
    cleaned = cleaned.replace(/\[\[audio_as_voice\]\]/gi, " ");
    audioAsVoice = true;
    hasTag = true;
  }

  // Clean up whitespace
  cleaned = cleaned
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();

  return { cleaned, audioAsVoice, hasTag };
}
