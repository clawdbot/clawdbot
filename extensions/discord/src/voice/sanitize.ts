import { stripInlineDirectiveTagsForDisplay } from "openclaw/plugin-sdk/text-chunking";
import { escapeRegExp } from "openclaw/plugin-sdk/text-utility-runtime";

const SPEECH_EMOJI_RE =
  /(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D|\p{Extended_Pictographic}|\p{Emoji_Modifier})*)+/gu;

function stripEmojiForSpeech(text: string): string {
  return text
    .replace(SPEECH_EMOJI_RE, " ")
    .replace(/\s+([?!.,:;])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

export function sanitizeVoiceReplyTextForSpeech(text: string, speakerLabel?: string): string {
  let cleaned = stripInlineDirectiveTagsForDisplay(text).text.trim();
  if (!cleaned) {
    return "";
  }

  const label = speakerLabel?.trim();
  if (label) {
    const prefix = new RegExp(`^${escapeRegExp(label)}\\s*:\\s*`, "i");
    cleaned = cleaned.replace(prefix, "").trim();
  }

  return stripEmojiForSpeech(cleaned);
}
