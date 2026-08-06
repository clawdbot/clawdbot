// Synology Chat plugin module maps one public callback URL to its internal Gateway route.

function normalizeExactPath(path: string): string {
  const trimmed = path.trim();
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/u, "") : "/";
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
  const webhookUrl = new URL(params.webhookUrl);
  if (
    webhookUrl.protocol !== "https:" ||
    !webhookUrl.hostname ||
    webhookUrl.username ||
    webhookUrl.password ||
    webhookUrl.hash
  ) {
    throw new Error(
      "Synology Chat webhookUrl must be an absolute HTTPS URL with a hostname and no credentials or fragment.",
    );
  }
  return {
    localRoutePath: toSynologyHostedMediaStoreRoutePath(params.webhookPath),
    publicBaseUrl: webhookUrl.origin,
    publicRoutePath: normalizeExactPath(webhookUrl.pathname),
    publicSearch: webhookUrl.search,
  };
}
