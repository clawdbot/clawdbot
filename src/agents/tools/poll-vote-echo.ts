type NormalizedPollEchoText = {
  emojiSignature: string;
  words: string;
};

// Keep the emoji identity while ignoring where it appears. Messages stores poll
// options with a trailing emoji, while models commonly restate the same emoji
// before the label. Retaining the signature avoids collapsing distinct options.
const POLL_ECHO_EMOJI_SEQUENCE =
  /(?:[0-9#*]\u{FE0F}?\u{20E3}|(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|[\u{E0020}-\u{E007F}]|\u{FE0E}|\u{FE0F}|\u{200D})+)/gu;

function normalizePollEchoText(text: string): NormalizedPollEchoText {
  let emojiSignature = "";
  const words = text
    .replace(POLL_ECHO_EMOJI_SEQUENCE, (emoji) => {
      emojiSignature += emoji.replace(/[\u{FE0E}\u{FE0F}]/gu, "");
      return " ";
    })
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.!?]+$/u, "")
    .trim()
    .toLowerCase();
  return { emojiSignature, words };
}

export function isPollVoteEchoText(option: string, outboundText: string): boolean {
  const normalizedOption = normalizePollEchoText(option);
  const normalizedOutbound = normalizePollEchoText(outboundText);
  const optionHasContent = Boolean(normalizedOption.words || normalizedOption.emojiSignature);
  if (!optionHasContent || normalizedOption.words !== normalizedOutbound.words) {
    return false;
  }
  if (normalizedOption.emojiSignature && normalizedOutbound.emojiSignature) {
    return normalizedOption.emojiSignature === normalizedOutbound.emojiSignature;
  }
  // A model may add or omit a decorative emoji around a word label. Emoji-only
  // options still require an exact signature so unrelated symbols never match.
  return Boolean(normalizedOption.words);
}
