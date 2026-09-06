const SAFE_ATTACHMENT_PROTOCOLS = new Set(["http:", "https:", "blob:"]);
const SAFE_MEDIA_DATA_URL = /^data:(audio|video)\/[a-z0-9!#$&^_.+-]+;base64,([a-z0-9+/]+={0,2})$/i;

/** Returns only attachment links that are safe to expose as clickable anchors. */
export function safeAttachmentHref(value: string): string | undefined {
  const href = value.trim();
  if (!href) {
    return undefined;
  }
  if (href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/\\")) {
    return href;
  }
  try {
    return SAFE_ATTACHMENT_PROTOCOLS.has(new URL(href).protocol.toLowerCase()) ? href : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps normalized base64 media usable without admitting scriptable data URL types. */
export function safeMediaAttachmentHref(
  value: string,
  expectedKind?: "audio" | "video",
): string | undefined {
  const href = value.trim();
  const match = SAFE_MEDIA_DATA_URL.exec(href);
  const payload = match?.[2];
  if (payload !== undefined) {
    return (!expectedKind || match?.[1]?.toLowerCase() === expectedKind) && payload.length % 4 === 0
      ? href
      : undefined;
  }
  return safeAttachmentHref(href);
}
