// Mattermost helper module supports emoji reaction name normalization.

// Mattermost's reaction API accepts only emoji short names, not a raw Unicode
// glyph, so the server rejects a glyph and the reaction never appears. Models
// routinely pass the glyph because the `emoji` param reads as "an emoji", so
// map the common ones to their short name to avoid that failure. Unknown values
// pass through unchanged (no regression). Mirrors the Slack plugin's handling.
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

// Strip skin-tone modifiers and variation selectors before lookup so a glyph
// like "👍🏽" resolves to the same base short name as "👍".
const EMOJI_SKIN_TONE_MODIFIER_RE = /[\u{1F3FB}-\u{1F3FF}]/gu;
const EMOJI_VARIATION_SELECTOR_RE = /[\u{FE00}-\u{FE0F}]/gu;

/**
 * Normalizes a caller-supplied emoji into a Mattermost short name. Accepts a
 * short name (with or without wrapping colons) or a raw Unicode glyph. Returns
 * `undefined` for blank input; unknown glyphs and short names are returned
 * unchanged so callers keep working for emoji outside the common map.
 */
export function normalizeMattermostEmojiName(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutColons = trimmed.replace(/^:+|:+$/g, "");
  if (!withoutColons) {
    return undefined;
  }
  const glyphKey = withoutColons
    .replace(EMOJI_SKIN_TONE_MODIFIER_RE, "")
    .replace(EMOJI_VARIATION_SELECTOR_RE, "");
  return MATTERMOST_EMOJI_SHORTNAME_BY_GLYPH[glyphKey] ?? withoutColons;
}
