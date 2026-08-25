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

/** Keeps document previews from turning persisted external URLs into browser network requests. */
export function isSameOriginAttachmentHref(value: string, baseHref: string): boolean {
  const href = safeAttachmentHref(value);
  if (!href) {
    return false;
  }
  try {
    const base = new URL(baseHref);
    return new URL(href, base).origin === base.origin;
  } catch {
    return false;
  }
}
