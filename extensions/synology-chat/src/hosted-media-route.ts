// Synology Chat plugin module maps one public callback URL to its internal Gateway route.

export const SYNOLOGY_HOSTED_MEDIA_TOKEN_PARAM_PREFIX = "__openclaw_synology_media_token";

function normalizeExactPath(path: string): string {
  const trimmed = path.trim();
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/u, "") : "/";
}

export function resolveSynologyPublicWebhookRouteKey(webhookUrlValue: string): string | undefined {
  try {
    const webhookUrl = new URL(webhookUrlValue);
    if (
      webhookUrl.protocol !== "https:" ||
      !webhookUrl.hostname ||
      webhookUrl.username ||
      webhookUrl.password ||
      webhookUrl.hash
    ) {
      return undefined;
    }
    webhookUrl.searchParams.sort();
    return webhookUrl.toString();
  } catch {
    return undefined;
  }
}

export function toSynologyHostedMediaStoreRoutePath(path: string): string {
  const normalized = normalizeExactPath(path);
  return normalized === "/" ? normalized : `${normalized}/`;
}

export function resolveSynologyHostedMediaRoute(params: {
  webhookPath: string;
  webhookUrl: string;
}): {
  localRoutePath: string;
  publicBaseUrl: string;
  publicRoutePath: string;
  publicSearch: string;
} {
  if (!params.webhookUrl.trim()) {
    throw new Error(
      "Synology Chat attachments require webhookUrl. Set the account's exact externally reachable HTTPS callback URL.",
    );
  }
  const routeKey = resolveSynologyPublicWebhookRouteKey(params.webhookUrl);
  if (!routeKey) {
    throw new Error(
      "Synology Chat webhookUrl must be an absolute HTTPS URL with a hostname and no credentials or fragment.",
    );
  }
  const webhookUrl = new URL(params.webhookUrl);
  if (
    [...webhookUrl.searchParams.keys()].some((key) =>
      key.startsWith(`${SYNOLOGY_HOSTED_MEDIA_TOKEN_PARAM_PREFIX}_`),
    )
  ) {
    throw new Error(
      `Synology Chat webhookUrl must not contain query parameters starting with ${SYNOLOGY_HOSTED_MEDIA_TOKEN_PARAM_PREFIX}_.`,
    );
  }
  return {
    localRoutePath: toSynologyHostedMediaStoreRoutePath(params.webhookPath),
    publicBaseUrl: webhookUrl.origin,
    // webhookUrl is the operator's exact proxy contract; trailing slashes and
    // encoded path segments can be route-significant and must not be rewritten.
    publicRoutePath: webhookUrl.pathname,
    publicSearch: webhookUrl.search,
  };
}
