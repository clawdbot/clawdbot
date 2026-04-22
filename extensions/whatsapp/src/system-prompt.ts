export function resolveWhatsAppGroupSystemPrompt(params: {
  accountConfig?: { groups?: Record<string, { systemPrompt?: string }> } | null;
  groupId?: string | null;
}): string | undefined {
  if (!params.groupId) {
    return undefined;
  }
  const groups = params.accountConfig?.groups;
  return (
    groups?.[params.groupId]?.systemPrompt?.trim() ||
    groups?.["*"]?.systemPrompt?.trim() ||
    undefined
  );
}

export function resolveWhatsAppDirectSystemPrompt(params: {
  accountConfig?: { direct?: Record<string, { systemPrompt?: string }> } | null;
  peerId?: string | null;
}): string | undefined {
  if (!params.peerId) {
    return undefined;
  }
  const direct = params.accountConfig?.direct;
  return (
    direct?.[params.peerId]?.systemPrompt?.trim() ||
    direct?.["*"]?.systemPrompt?.trim() ||
    undefined
  );
}
