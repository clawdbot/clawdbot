// Mattermost helper module supports emoji reaction name normalization.

// Mattermost rejects raw reaction glyphs; preserve unknown names while mapping
// common model-supplied emoji to the short names its API accepts.
const MATTERMOST_EMOJI_SHORTNAME_BY_GLYPH: Record<string, string> = {
  "✅": "white_check_mark",
  "❌": "x",
  "👍": "thumbsup",
  "👎": "thumbsdown",
  "🎉": "tada",
  "❤": "heart",
  "😄": "smile",
  "😂": "joy",
  "🚀": "rocket",
  "👀": "eyes",
  "🙏": "pray",
  "🔥": "fire",
  "💯": "100",
  "⚠": "warning",
  "➕": "heavy_plus_sign",
  "➖": "heavy_minus_sign",
  "🤔": "thinking_face",
  "⚡": "zap",
  "🌐": "globe_with_meridians",
  "😱": "scream",
  "🧠": "brain",
  "💻": "computer",
  "👋": "wave",
  "🙌": "raised_hands",
};

// Mattermost names toned system emoji `<base>_<suffix>`; these five bases are
// the only Unicode emoji-modifier bases in the map above, so composing outside
// this set would emit a name the server does not have.
const MATTERMOST_EMOJI_TONE_CAPABLE_NAMES = new Set([
  "thumbsup",
  "thumbsdown",
  "pray",
  "wave",
  "raised_hands",
]);

const MATTERMOST_EMOJI_TONE_SUFFIX_BY_MODIFIER = new Map<string, string>([
  ["\u{1F3FB}", "light_skin_tone"],
  ["\u{1F3FC}", "medium_light_skin_tone"],
  ["\u{1F3FD}", "medium_skin_tone"],
  ["\u{1F3FE}", "medium_dark_skin_tone"],
  ["\u{1F3FF}", "dark_skin_tone"],
]);

// Skin tones and variation selectors must not prevent their base glyph lookup.
const EMOJI_SKIN_TONE_MODIFIER_RE = /[\u{1F3FB}-\u{1F3FF}]/gu;
const EMOJI_VARIATION_SELECTOR_RE = /[\u{FE00}-\u{FE0F}]/gu;

export function normalizeMattermostEmojiName(raw: string | undefined): string | undefined {
  const withoutColons = raw?.trim().replace(/^:+|:+$/g, "");
  if (!withoutColons) {
    return undefined;
  }
  const toneModifier = withoutColons.match(EMOJI_SKIN_TONE_MODIFIER_RE)?.[0];
  const glyphKey = withoutColons
    .replace(EMOJI_SKIN_TONE_MODIFIER_RE, "")
    .replace(EMOJI_VARIATION_SELECTOR_RE, "");
  const shortname = Object.hasOwn(MATTERMOST_EMOJI_SHORTNAME_BY_GLYPH, glyphKey)
    ? MATTERMOST_EMOJI_SHORTNAME_BY_GLYPH[glyphKey]
    : undefined;
  if (shortname === undefined) {
    return withoutColons;
  }
  const toneSuffix = toneModifier
    ? MATTERMOST_EMOJI_TONE_SUFFIX_BY_MODIFIER.get(toneModifier)
    : undefined;
  if (!toneSuffix || !MATTERMOST_EMOJI_TONE_CAPABLE_NAMES.has(shortname)) {
    return shortname;
  }
  return `${shortname}_${toneSuffix}`;
}
