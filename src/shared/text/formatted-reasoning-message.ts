// Formatted reasoning message helpers remove reasoning tags before display.
import { stripReasoningTagsFromText } from "./reasoning-tags.js";

/** Strip provider-formatted Reasoning/Thinking preambles from visible text. */
export function stripFormattedReasoningMessage(text: string): string {
  const stripped = stripReasoningTagsFromText(text);
  const firstNewline = stripped.indexOf("\n");
  const prefix = (firstNewline === -1 ? stripped : stripped.slice(0, firstNewline)).trim();
  const thinking = /^Thinking\.{0,3}$/u.test(prefix);
  if (prefix !== "Reasoning:" && !thinking) {
    return stripped;
  }

  let offset = firstNewline === -1 ? stripped.length : firstNewline + 1;
  let hasSummary = false;
  while (offset < stripped.length) {
    const newline = stripped.indexOf("\n", offset);
    const end = newline === -1 ? stripped.length : newline;
    const line = stripped.slice(offset, end).trim();
    const isSummary = line.length >= 2 && line.startsWith("_") && line.endsWith("_");
    if (line && !isSummary) {
      break;
    }
    hasSummary ||= isSummary;
    offset = end + 1;
  }
  // Thinking needs an italic summary. Normalize CRLF only when removing a preamble;
  // ordinary messages retain their original bytes, including bare carriage returns.
  return thinking && !hasSummary ? stripped : stripped.slice(offset).replace(/\r\n/g, "\n").trim();
}
