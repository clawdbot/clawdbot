const REPLY_TAG_RE =
  /\[\[\s*(?:reply_to_current|reply_to\s*:\s*([^\]\n]+))\s*\]\]/gi;

function normalizeReplyText(text: string) {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}

export function extractReplyToTag(
  text?: string,
  currentMessageId?: string,
): {
  cleaned: string;
  replyToId?: string;
  hasTag: boolean;
} {
  if (!text) return { cleaned: "", hasTag: false };

  let sawCurrent = false;
  let lastExplicitId: string | undefined;
  let hasTag = false;

  const cleaned = normalizeReplyText(
    text.replace(REPLY_TAG_RE, (_full, idRaw: string | undefined) => {
      hasTag = true;
      if (idRaw === undefined) {
        sawCurrent = true;
        return " ";
      }

      const id = idRaw.trim();
      if (id) lastExplicitId = id;
      return " ";
    }),
  );

  const replyToId =
    lastExplicitId ??
    (sawCurrent ? currentMessageId?.trim() || undefined : undefined);

  return { cleaned, replyToId, hasTag };
}
