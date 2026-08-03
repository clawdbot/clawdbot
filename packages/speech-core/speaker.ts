// Speaker-selection compatibility helpers for plugins that renamed voice fields
// over time but still need one normalized config object.
export type SpeakerSelectionConfig = Record<string, unknown>;

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Populate canonical and legacy speaker voice fields together. */
export function withSpeakerSelectionCompat(
  config: SpeakerSelectionConfig | undefined,
): SpeakerSelectionConfig {
  const next: SpeakerSelectionConfig = config ? { ...config } : {};
  const speakerVoice = readString(next.speakerVoice);
  const speakerVoiceId = readString(next.speakerVoiceId);
  const voice = readString(next.voice);
  const voiceName = readString(next.voiceName);
  const voiceId = readString(next.voiceId);
  const canonicalVoice = speakerVoice ?? voice ?? voiceName;
  const canonicalVoiceId = speakerVoiceId ?? voiceId;
  if (canonicalVoice) {
    next.speakerVoice = canonicalVoice;
    next.voice = canonicalVoice;
    next.voiceName = canonicalVoice;
  }
  if (canonicalVoiceId) {
    next.speakerVoiceId = canonicalVoiceId;
    next.voiceId = canonicalVoiceId;
  }
  return next;
}

/** Fill legacy speaker fields only when callers have not set them explicitly. */
export function withSpeakerSelectionFallbackCompat(
  config: SpeakerSelectionConfig | undefined,
): SpeakerSelectionConfig {
  const next: SpeakerSelectionConfig = config ? { ...config } : {};
  const speakerVoice = readString(next.speakerVoice);
  const speakerVoiceId = readString(next.speakerVoiceId);
  if (speakerVoice) {
    next.voice ??= speakerVoice;
    next.voiceName ??= speakerVoice;
  }
  if (speakerVoiceId) {
    next.voiceId ??= speakerVoiceId;
  }
  return next;
}
