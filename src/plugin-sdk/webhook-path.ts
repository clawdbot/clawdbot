/**
 * @deprecated Compatibility subpath. Import webhook path helpers from
 * `openclaw/plugin-sdk/webhook-ingress` instead.
 */

/** @deprecated Import from `openclaw/plugin-sdk/webhook-ingress` instead. */
export function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "/";
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.slice(0, -1);
  }
  return withSlash;
}

/** @deprecated Import from `openclaw/plugin-sdk/webhook-ingress` instead. */
export function resolveWebhookPath(params: {
  webhookPath?: string;
  webhookUrl?: string;
  defaultPath?: string | null;
}): string | null {
  const trimmedPath = params.webhookPath?.trim();
  if (trimmedPath) {
    return normalizeWebhookPath(trimmedPath);
  }
  if (params.webhookUrl?.trim()) {
    try {
      const parsed = new URL(params.webhookUrl);
      return normalizeWebhookPath(parsed.pathname || "/");
    } catch {
      return null;
    }
  }
  return params.defaultPath ?? null;
}
