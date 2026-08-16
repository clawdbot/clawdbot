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
// sequence (ZWJ families, flags, keycaps included) and nothing else. Construct
// it dynamically because the repository TypeScript target rejects literal `v` flags.
const SESSION_ICON_RE = new RegExp("^\\p{RGI_Emoji}$", "v");

export function normalizeSessionIconValue(value: string): string | null {
  const normalized = value.trim();
  return SESSION_ICON_RE.test(normalized) || SESSION_ICON_GLYPH_ID_SET.has(normalized)
    ? normalized
    : null;
}

export type SessionAgentStatus = {
  note: string;
  expiresAt: number;
  attention?: SessionAgentAttentionIconId;
};
