// Whatsapp plugin module implements system prompt behavior.
function resolveWhatsAppSystemPrompt(
  prompts: Record<string, { systemPrompt?: string | null }> | undefined,
  targetId: string | null | undefined,
): string | undefined {
  if (!targetId) {
    return undefined;
  }
  const selected = prompts?.[targetId]?.systemPrompt ?? prompts?.["*"]?.systemPrompt;
  return selected?.trim() || undefined;
}

export function resolveWhatsAppGroupSystemPrompt(params: {
  accountConfig?: { groups?: Record<string, { systemPrompt?: string | null }> } | null;
  groupId?: string | null;
}): string | undefined {
  return resolveWhatsAppSystemPrompt(params.accountConfig?.groups, params.groupId);
}

export function resolveWhatsAppDirectSystemPrompt(params: {
  accountConfig?: { direct?: Record<string, { systemPrompt?: string | null }> } | null;
  peerId?: string | null;
}): string | undefined {
  return resolveWhatsAppSystemPrompt(params.accountConfig?.direct, params.peerId);
}
