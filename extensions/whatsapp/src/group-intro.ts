// Whatsapp plugin module implements group mention normalization.
export function resolveWhatsAppMentionStripRegexes(ctx: { To?: string | null }): RegExp[] {
  const selfE164 = (ctx.To ?? "").replace(/^whatsapp:/i, "");
  if (!selfE164) {
    return [];
  }
  const escaped = selfE164.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [new RegExp(escaped, "g"), new RegExp(`@${escaped}`, "g")];
}
