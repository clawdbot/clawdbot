/**
 * Voice transcript formatting utility.
 *
 * Zero external dependencies — pure string formatting.
 */

/** Format voice transcripts into user-visible text. */
export function formatVoiceText(transcripts: string[]): string {
  if (transcripts.length === 0) {
    return "";
  }
  return transcripts.length === 1
    ? `[Voice message] ${transcripts[0]}`
    : transcripts.map((t, i) => `[Voice ${i + 1}] ${t}`).join("\n");
}
