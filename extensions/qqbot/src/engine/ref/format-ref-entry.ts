/**
 * Format a ref-index entry into text suitable for model context.
 *
 * Zero external dependencies — pure string formatting.
 */

import type { RefIndexEntry } from "./types.js";

/** Format a ref-index entry into text suitable for model context. */
export function formatRefEntryForAgent(entry: RefIndexEntry): string {
  const parts: string[] = [];

  if (entry.content.trim()) {
    parts.push(entry.content);
  }

  if (entry.attachments?.length) {
    for (const att of entry.attachments) {
      const sourceHint = att.localPath ? ` (${att.localPath})` : att.url ? ` (${att.url})` : "";
      switch (att.type) {
        case "image":
          parts.push(`[image${att.filename ? `: ${att.filename}` : ""}${sourceHint}]`);
          break;
        case "voice":
          if (att.transcript) {
            const sourceMap: Record<string, string> = {
              stt: "local STT",
              asr: "platform ASR",
              tts: "TTS source",
              fallback: "fallback text",
            };
            const sourceTag = att.transcriptSource
              ? ` - ${sourceMap[att.transcriptSource] || att.transcriptSource}`
              : "";
            parts.push(`[voice message (content: "${att.transcript}"${sourceTag})${sourceHint}]`);
          } else {
            parts.push(`[voice message${sourceHint}]`);
          }
          break;
        case "video":
          parts.push(`[video${att.filename ? `: ${att.filename}` : ""}${sourceHint}]`);
          break;
        case "file":
          parts.push(`[file${att.filename ? `: ${att.filename}` : ""}${sourceHint}]`);
          break;
        default:
          parts.push(`[attachment${att.filename ? `: ${att.filename}` : ""}${sourceHint}]`);
      }
    }
  }

  return parts.join(" ") || "[empty message]";
}
