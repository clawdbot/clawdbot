// Msteams plugin module implements reaction type normalization.
const TEAMS_REACTION_EMOJI: Record<string, string> = {
  like: "\u{1F44D}",
  heart: "\u2764\uFE0F",
  laugh: "\u{1F606}",
  surprised: "\u{1F62E}",
  sad: "\u{1F622}",
  angry: "\u{1F621}",
};

const TEAMS_REACTION_TYPES = Object.keys(TEAMS_REACTION_EMOJI);

export function getMSTeamsReactionEmoji(raw: string): string | undefined {
  const key = raw.trim().toLowerCase();
  return Object.hasOwn(TEAMS_REACTION_EMOJI, key) ? TEAMS_REACTION_EMOJI[key] : undefined;
}

export function resolveMSTeamsReactionEmoji(raw: string): string {
  const normalized = raw.trim();
  if (!normalized) {
    throw new Error(`Reaction type is required. Common types: ${TEAMS_REACTION_TYPES.join(", ")}`);
  }
  return getMSTeamsReactionEmoji(normalized) ?? normalized;
}
