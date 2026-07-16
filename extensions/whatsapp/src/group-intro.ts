// Whatsapp plugin module implements group intro behavior.
const WHATSAPP_GROUP_INTRO_HINT =
  "WhatsApp IDs: SenderId is the participant JID (group participant id).";

/**
 * @deprecated Core never consumed the group intro hint adapter; this export
 * remains only for the plugin API surface and is removed after the next
 * release train together with ChannelGroupAdapter.resolveGroupIntroHint.
 */
export function resolveWhatsAppGroupIntroHint(): string {
  return WHATSAPP_GROUP_INTRO_HINT;
}

export function resolveWhatsAppMentionStripRegexes(ctx: { To?: string | null }): RegExp[] {
  const selfE164 = (ctx.To ?? "").replace(/^whatsapp:/i, "");
  if (!selfE164) {
    return [];
  }
  const escaped = selfE164.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [new RegExp(escaped, "g"), new RegExp(`@${escaped}`, "g")];
}
