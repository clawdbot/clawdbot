const SAFE_ATTACHMENT_PROTOCOLS = new Set(["http:", "https:", "blob:"]);

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
