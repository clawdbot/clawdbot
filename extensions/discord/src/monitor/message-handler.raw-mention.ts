import { findCodeRegions, isInsideCode } from "openclaw/plugin-sdk/text-chunking";

export function hasRawDiscordUserMention(text: string, userId?: string): boolean {
  if (!userId) {
    return false;
  }
  const codeRegions = findCodeRegions(text);
  for (const mention of [`<@${userId}>`, `<@!${userId}>`]) {
    let index = text.indexOf(mention);
    while (index >= 0) {
      let precedingBackslashes = 0;
      for (let offset = index - 1; offset >= 0 && text[offset] === "\\"; offset -= 1) {
        precedingBackslashes += 1;
      }
      if (precedingBackslashes % 2 === 0 && !isInsideCode(index, codeRegions)) {
        return true;
      }
      index = text.indexOf(mention, index + mention.length);
    }
  }
  return false;
}
