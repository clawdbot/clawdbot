// Firecrawl helper module supports result URL identity behavior.

const FIRECRAWL_RESULT_URL_MAX_CHARS = 2_048;

/**
 * Normalizes a URL a Firecrawl response claims, or `undefined` when the claim is unusable.
 *
 * Firecrawl result URLs are untrusted input that ends up in tool output, so anything that is not
 * a bounded http(s) URL is dropped rather than surfaced.
 */
export function normalizeFirecrawlResultUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > FIRECRAWL_RESULT_URL_MAX_CHARS) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.href.length > FIRECRAWL_RESULT_URL_MAX_CHARS
    ) {
      return undefined;
    }
    // Preserve shipped bare-origin spellings while percent-encoding all other untrusted input.
    return url.href === `${value}/` ? value : url.href;
  } catch {
    return undefined;
  }
}

/**
 * Canonicalizes one URL-valued cache-key dimension.
 *
 * `normalizeCacheKey` deliberately preserves case, because a composed key mixes dimensions
 * whose case is significant (paths, query values, model ids). URL-valued dimensions are the
 * exception: RFC 3986 §3.1/§6.2.2.1 make scheme and host case-insensitive, so leaving them
 * raw splits one resource across several cache entries. The owner of a key applies the rule to
 * its own URL dimension, so it lives with that key rather than inside `normalizeCacheKey`.
 *
 * Unparseable input is returned untouched: this runs while composing a cache key, before the
 * request that is entitled to reject a bad URL, so it must never be the thing that throws.
 */
export function canonicalizeUrlCacheDimension(value: string): string {
  try {
    return new URL(value).href;
  } catch {
    return value;
  }
}

/**
 * Reads the source URL Firecrawl reported for a scrape, or `undefined` when it reported none.
 *
 * The scrape result's `finalUrl` falls back to the request URL when this returns `undefined`, so
 * callers that must tell a provider statement from an echo of their own input ask here rather than
 * comparing the stored strings: Firecrawl is free to report a source URL equal to the request.
 *
 * Each candidate goes through the same `normalizeFirecrawlResultUrl` gate the reported `finalUrl`
 * passes, so a candidate the result would reject is not counted as a statement either.
 */
export function readFirecrawlReportedSourceUrl(data: Record<string, unknown>): string | undefined {
  const metadata =
    data.metadata && typeof data.metadata === "object"
      ? (data.metadata as Record<string, unknown>)
      : undefined;
  return normalizeFirecrawlResultUrl(metadata?.sourceURL) ?? normalizeFirecrawlResultUrl(data.url);
}

/**
 * One cached scrape result plus the provenance the result itself cannot express.
 *
 * `finalUrl` carries either a URL Firecrawl reported or the request URL the parser fell back to,
 * and the two are indistinguishable once stored: Firecrawl may report a source URL whose text
 * equals the request. Recording which one it was at parse time keeps the cache-hit rebind from
 * having to guess.
 */
export type ScrapeCacheEntry = {
  result: Record<string, unknown>;
  finalUrlReportedByProvider: boolean;
};

/**
 * Rebinds a cached scrape result onto the URL the current caller asked for.
 *
 * The scrape cache key canonicalizes its URL dimension, so one entry now serves every
 * case-equivalent spelling of the same resource. Two fields in a stored result echo the request
 * that populated it: `url` is the requested URL verbatim, and `finalUrl` falls back to it when
 * Firecrawl reports no source URL of its own. Replaying those would hand a later caller the first
 * caller's spelling, so both echoes are re-bound to the current request.
 *
 * Whether `finalUrl` is such an echo is read from the entry's recorded provenance, not from
 * `finalUrl === storedUrl`: Firecrawl may report a source URL whose text equals the request that
 * populated the entry, and that value is the provider's statement about the resource. It is left
 * untouched.
 */
export function rebindScrapeRequestUrl(
  entry: ScrapeCacheEntry,
  requestUrl: string,
): Record<string, unknown> {
  const storedUrl = entry.result.url;
  if (typeof storedUrl !== "string" || storedUrl === requestUrl) {
    return entry.result;
  }
  return {
    ...entry.result,
    url: requestUrl,
    ...(entry.finalUrlReportedByProvider ? {} : { finalUrl: requestUrl }),
  };
}
