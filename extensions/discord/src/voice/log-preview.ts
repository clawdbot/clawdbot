import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const DISCORD_VOICE_LOG_PREVIEW_CHARS = 500;

export function formatVoiceLogPreview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= DISCORD_VOICE_LOG_PREVIEW_CHARS) {
    return oneLine;
  }
  return `${truncateUtf16Safe(oneLine, DISCORD_VOICE_LOG_PREVIEW_CHARS)}...`;
}
