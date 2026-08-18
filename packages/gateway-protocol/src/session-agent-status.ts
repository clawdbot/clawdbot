export const SESSION_AGENT_ATTENTION_ICON_IDS = [
  "hand",
  "key",
  "alert",
  "flag",
  "lock",
  "hourglass",
] as const;

export type SessionAgentAttentionIconId = (typeof SESSION_AGENT_ATTENTION_ICON_IDS)[number];

export const SESSION_ICON_GLYPH_IDS = [
  "braces",
  "book",
  "monitor",
  "bot",
  "kanban",
  "coins",
] as const;

export type SessionIconGlyphId = (typeof SESSION_ICON_GLYPH_IDS)[number];

const SESSION_ICON_GLYPH_ID_SET = new Set<string>(SESSION_ICON_GLYPH_IDS);
// Anchored RGI_Emoji admits exactly one recommended-for-interchange emoji
// sequence (ZWJ families, flags, keycaps included) and nothing else. Constructed
// lazily: the TypeScript target rejects literal `v` flags, and this module also
// loads in the browser (session-menu picker), where a pre-Unicode-Sets engine
// must not throw at module evaluation. Server runtimes (Node 22+) always take
// the exact path; `null` marks an engine without `v`-flag support.
let sessionIconRe: RegExp | null | undefined;
function sessionIconPattern(): RegExp | null {
  if (sessionIconRe === undefined) {
    try {
      sessionIconRe = new RegExp("^\\p{RGI_Emoji}$", "v");
    } catch {
      sessionIconRe = null;
    }
  }
  return sessionIconRe;
}

function isSingleNonAsciiGrapheme(value: string): boolean {
  if (value.length > 16 || /^[!-~]$/u.test(value)) {
    return false;
  }
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)];
  return graphemes.length === 1;
}

export function normalizeSessionIconValue(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  if (SESSION_ICON_GLYPH_ID_SET.has(normalized)) {
    return normalized;
  }
  const pattern = sessionIconPattern();
  // Pre-Unicode-Sets browsers get the older grapheme heuristic as client-side
  // pre-validation only; the Gateway re-validates with the exact RGI pattern.
  const accepted = pattern ? pattern.test(normalized) : isSingleNonAsciiGrapheme(normalized);
  return accepted ? normalized : null;
}

export type SessionAgentStatus = {
  note: string;
  expiresAt: number;
  attention?: SessionAgentAttentionIconId;
};
