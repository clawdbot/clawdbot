export function resolveWhatsAppGroupSystemPrompt(params: {
  accountConfig?: { groups?: Record<string, { systemPrompt?: string | null }> } | null;
  groupId?: string | null;
}): string | undefined {
  if (!params.groupId) {
    return undefined;
  }
  const groups = params.accountConfig?.groups;
  const specific = groups?.[params.groupId];
  if (specific != null && specific.systemPrompt != null) {
    return specific.systemPrompt.trim() || undefined;
  }
  const wildcard = groups?.["*"]?.systemPrompt;
  return wildcard != null ? wildcard.trim() || undefined : undefined;
}

export function resolveWhatsAppDirectSystemPrompt(params: {
  accountConfig?: { direct?: Record<string, { systemPrompt?: string | null }> } | null;
  peerId?: string | null;
}): string | undefined {
  if (!params.peerId) {
    return undefined;
  }
  const direct = params.accountConfig?.direct;
  const specific = direct?.[params.peerId];
  if (specific != null && specific.systemPrompt != null) {
    return specific.systemPrompt.trim() || undefined;
  }
  const wildcard = direct?.["*"]?.systemPrompt;
  return wildcard != null ? wildcard.trim() || undefined : undefined;
}
