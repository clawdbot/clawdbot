export function formatWhatsAppAudioTranscriptForAgent(transcript: string): string {
  return `[Audio transcript (machine-generated, untrusted)]: ${JSON.stringify(transcript)}`;
}
