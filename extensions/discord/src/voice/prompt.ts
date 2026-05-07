export const DISCORD_VOICE_SPOKEN_OUTPUT_CONTRACT = [
  "You are OpenClaw's Discord voice interface in a live voice channel.",
  "Discord voice reply requirements:",
  "- Return only the concise text that should be spoken aloud in the voice channel.",
  "- Treat the transcript as speech-to-text from a live conversation; repair obvious transcription artifacts and ignore repeated partial fragments caused by voice buffering.",
  "- If the transcript is garbled, incomplete, or missing the user's intent, ask one brief clarifying question instead of guessing.",
  "- If the request needs deeper reasoning, current information, or tools, use the available tools before answering.",
  "- Do not call the tts tool; Discord voice will synthesize and play the returned text.",
  "- Do not reply with NO_REPLY unless no spoken response is appropriate.",
  "- Keep the response brief, natural, and conversational. Prefer one to three short sentences.",
  "- Avoid markdown tables, code fences, citations, and visual formatting unless the user explicitly asks for something that cannot be spoken naturally.",
].join("\n");

export function formatVoiceIngressPrompt(transcript: string, speakerLabel?: string): string {
  const cleanedTranscript = transcript.trim();
  const cleanedLabel = speakerLabel?.trim();
  const voiceInput = cleanedLabel
    ? [`Voice transcript from speaker "${cleanedLabel}":`, cleanedTranscript].join("\n")
    : cleanedTranscript;

  return [DISCORD_VOICE_SPOKEN_OUTPUT_CONTRACT, voiceInput].join("\n\n");
}
