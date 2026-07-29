// Provides manual transcript source entries for user-supplied transcript text.
import type { TranscriptSourceProvider } from "./provider-types.js";

/**
 * Manual transcript import provider.
 *
 * This provider turns pasted text into final transcript utterances, optionally
 * splitting "Speaker: text" prefixes into speaker labels.
 */
function parseSpeakerLine(line: string): { speakerLabel?: string; text: string } {
  const match = /^([^:\n]{1,80}):\s+(.+)$/.exec(line.trim());
  if (!match) {
    return { text: line.trim() };
  }
  return { speakerLabel: match[1]?.trim(), text: match[2]?.trim() ?? "" };
}

/** Built-in provider for post-hoc transcript text imports. */
export const manualTranscriptSourceProvider: TranscriptSourceProvider = {
  id: "manual-transcript",
  aliases: ["import", "transcript"],
  name: "Manual Transcript Import",
  sourceKinds: ["posthoc-transcript"],
  async importTranscript(request) {
    const now = new Date().toISOString();
    return request.text
      .split(/\r?\n/)
      .map((line) => parseSpeakerLine(line))
      .filter((entry) => entry.text)
      .map((entry, index) => ({
        id: `${request.session.sessionId}-${index + 1}`,
        sessionId: request.session.sessionId,
        startedAt: now,
        final: true,
        speaker: {
          label: entry.speakerLabel ?? request.speakerLabel ?? "Speaker",
        },
        text: entry.text,
      }));
  },
};
