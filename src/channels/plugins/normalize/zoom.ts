export function normalizeZoomMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // Strip optional zoom: prefix
  const withoutPrefix = trimmed.replace(/^zoom:/i, "").trim();
  if (!withoutPrefix) return undefined;

  return withoutPrefix;
}

export function looksLikeZoomTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;

  // Zoom JIDs contain @xmpp or @xmppdev
  if (trimmed.includes("@xmpp") || trimmed.includes("@xmppdev")) return true;

  // Or starts with zoom: prefix
  if (/^zoom:/i.test(trimmed)) return true;

  return false;
}
