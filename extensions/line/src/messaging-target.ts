export function normalizeLineMessagingTarget(target: string): string | undefined {
  const trimmed = target.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^line:(group|room|user):/i, "").replace(/^line:/i, "");
}

export function inferLineTargetChatType(target: string): "direct" | "group" | undefined {
  const normalized = normalizeLineMessagingTarget(target);
  if (!normalized) {
    return undefined;
  }
  if (/^U[a-f0-9]{32}$/i.test(normalized)) {
    return "direct";
  }
  return /^[CR][a-f0-9]{32}$/i.test(normalized) ? "group" : undefined;
}
