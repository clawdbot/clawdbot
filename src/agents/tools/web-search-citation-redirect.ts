/**
 * Citation redirect resolver for web search results.
 *
 * Follows provider citation redirect URLs through the strict web-tools network guard.
 */
import { withStrictWebToolsEndpoint } from "./web-guarded-fetch.js";

const REDIRECT_TIMEOUT_MS = 5000;

/**
 * Resolve a citation redirect URL to its final destination using a HEAD request.
 * Returns the original URL if resolution fails or times out.
 */
export async function resolveCitationRedirectUrl(url: string): Promise<string> {
  try {
    return await withStrictWebToolsEndpoint(
      {
        url,
        init: { method: "HEAD" },
        timeoutMs: REDIRECT_TIMEOUT_MS,
      },
      async ({ finalUrl }) => finalUrl || url,
    );
  } catch {
    return url;
  }
}
