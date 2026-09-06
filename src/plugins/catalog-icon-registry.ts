// Exact icon URLs learned from authenticated ClawHub catalog responses.
const MAX_CATALOG_ICON_URLS = 1_024;

const catalogIconUrls = new Set<string>();

function normalizeCatalogIconUrl(value: string): string | undefined {
  if (!value || value.length > 2_048) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname && !url.username && !url.password && !url.hash
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function registerClawHubCatalogIconUrls(values: Iterable<string | undefined>): void {
  for (const value of values) {
    if (!value) {
      continue;
    }
    const normalized = normalizeCatalogIconUrl(value);
    if (!normalized) {
      continue;
    }
    catalogIconUrls.delete(normalized);
    catalogIconUrls.add(normalized);
    if (catalogIconUrls.size > MAX_CATALOG_ICON_URLS) {
      const oldest = catalogIconUrls.values().next().value;
      if (oldest) {
        catalogIconUrls.delete(oldest);
      }
    }
  }
}

export function resolveClawHubCatalogIconUrl(value: string): string | undefined {
  const normalized = normalizeCatalogIconUrl(value);
  return normalized && catalogIconUrls.has(normalized) ? normalized : undefined;
}
