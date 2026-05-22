import { stripReasoningTagsFromText } from "./reasoning-tags.js";

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

  let index = 1;
  while (index < lines.length) {
    const trimmed = lines[index]?.trim() ?? "";
    if (!trimmed || (trimmed.startsWith("_") && trimmed.endsWith("_") && trimmed.length >= 2)) {
      index += 1;
      continue;
    }
    break;
  }
  return lines.slice(index).join("\n").trim();
}
