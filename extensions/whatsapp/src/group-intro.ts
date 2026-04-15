export const WHATSAPP_GROUP_INTRO_HINT =
  "WhatsApp IDs: SenderId is the participant JID (group participant id).";

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
