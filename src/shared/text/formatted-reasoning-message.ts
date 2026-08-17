// Formatted reasoning message helpers remove reasoning tags before display.
import { stripReasoningTagsFromText } from "./reasoning-tags.js";

/** Strip provider-formatted Reasoning/Thinking preambles from visible text. */
export function stripFormattedReasoningMessage(text: string): string {
  const stripped = stripReasoningTagsFromText(text);
  const lines = stripped.split(/\r?\n/u);
  const prefix = lines[0]?.trim();
  if (prefix !== "Reasoning:" && !/^Thinking\.{0,3}$/u.test(prefix ?? "")) {
    return stripped;
  }
  if (/^Thinking\.{0,3}$/u.test(prefix ?? "")) {
    const firstBodyLine = lines.slice(1).find((line) => line.trim());
    const trimmedBodyLine = firstBodyLine?.trim() ?? "";
    if (
      !trimmedBodyLine ||
      !(
        trimmedBodyLine.startsWith("_") &&
        trimmedBodyLine.endsWith("_") &&
        trimmedBodyLine.length >= 2
      )
    ) {
      return stripped;
    }
  }

  // Remove blank/italic summary preamble lines but preserve the substantive
  // answer body after the first non-preamble line. Leading whitespace carries
  // meaning (e.g. Markdown indented code blocks), so it is kept exactly; only
  // trailing newlines are stripped, since they are format residue that can
  // render as a spurious blank line in some channels.
  let index = 1;
  while (index < lines.length) {
    const trimmed = lines[index]?.trim() ?? "";
    if (!trimmed || (trimmed.startsWith("_") && trimmed.endsWith("_") && trimmed.length >= 2)) {
      index += 1;
      continue;
    }
    break;
  }
  const body = lines.slice(index).join("\n");
  return body.replace(/\n+$/u, "");
}
