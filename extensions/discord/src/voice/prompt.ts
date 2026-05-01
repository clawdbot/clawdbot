export const DISCORD_VOICE_SPOKEN_OUTPUT_CONTRACT = [
  "Discord voice reply requirements:",
  "- Return only the concise text that should be spoken aloud in the voice channel.",
  "- Do not call the tts tool; Discord voice will synthesize and play the returned text.",
  "- Do not reply with NO_REPLY unless no spoken response is appropriate.",
  "- Keep the response brief and conversational.",
].join("\n");

export function formatVoiceIngressPrompt(transcript: string, speakerLabel?: string): string {
  const cleanedTranscript = transcript.trim();
  const cleanedLabel = speakerLabel?.trim();
  const voiceInput = cleanedLabel
    ? [`Voice transcript from speaker "${cleanedLabel}":`, cleanedTranscript].join("\n")
    : cleanedTranscript;

  return [DISCORD_VOICE_SPOKEN_OUTPUT_CONTRACT, voiceInput].join("\n\n");
}
