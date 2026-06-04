/**
 * @deprecated Compatibility subpath. Import webhook path helpers from
 * `openclaw/plugin-sdk/webhook-ingress` instead.
 */

/**
 * Normalizes plugin webhook paths to an absolute path without a trailing slash.
 * Empty values resolve to `/` so route registration and request matching use the
 * same canonical key.
 *
 * @deprecated Import from `openclaw/plugin-sdk/webhook-ingress` instead.
 */
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

/**
 * Resolves a webhook path from explicit path config, then URL pathname, then
 * caller default. Invalid webhook URLs resolve to `null` instead of guessing.
 *
 * @deprecated Import from `openclaw/plugin-sdk/webhook-ingress` instead.
 */
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
