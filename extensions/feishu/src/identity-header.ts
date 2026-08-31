// Feishu identity header helpers keep card titles free of prose-only emoji config.

type IdentityHeaderInput = {
  emoji?: string;
  name?: string;
};

const emojiSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

const keycapEmojiPattern = /^[0-9#*]\uFE0F?\u20E3$/u;
const emojiLikeSegmentPattern =
  /[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Regional_Indicator}]/u;

function splitGraphemes(input: string): string[] {
  if (!emojiSegmenter) {
    return Array.from(input);
  }
  return Array.from(emojiSegmenter.segment(input), (segment) => segment.segment);
}

function isEmojiSegment(segment: string): boolean {
  return keycapEmojiPattern.test(segment) || emojiLikeSegmentPattern.test(segment);
}

export function resolveFeishuIdentityEmoji(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const emoji = splitGraphemes(trimmed).filter(isEmojiSegment).join("");
  return emoji || undefined;
}

export function resolveFeishuIdentityHeaderTitle(identity: IdentityHeaderInput | undefined) {
  if (!identity) {
    return "";
  }
  const name = identity.name?.trim() ?? "";
  const emoji = resolveFeishuIdentityEmoji(identity.emoji);
  return (emoji ? `${emoji} ${name}` : name).trim();
}
