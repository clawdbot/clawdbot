// Fetch auth helpers provide scoped bearer-token retries for plugin HTTP requests.
import {
  normalizeHeadersInitForFetch,
  normalizeRequestInitHeadersForFetch,
} from "../infra/fetch-headers.js";

/** Token source used by scoped bearer-auth fetch retries. */
export type ScopeTokenProvider = {
  /** Return a bearer token for the requested OAuth/API scope. */
  getAccessToken: (scope: string) => Promise<string>;
};

function isAuthFailureStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/** Retry a fetch with bearer tokens from the provided scopes when the unauthenticated attempt fails. */
export async function fetchWithBearerAuthScopeFallback(params: {
  /** Absolute URL to request. */
  url: string;
  /** Token scopes to try in order after the initial unauthenticated request fails. */
  scopes: readonly string[];
  /** Optional token source; when omitted, only the unauthenticated request is attempted. */
  tokenProvider?: ScopeTokenProvider;
  /** Fetch implementation override for tests or plugin runtimes. Defaults to global `fetch`. */
  fetchFn?: typeof fetch;
  /** Request options reused across unauthenticated and authenticated attempts. */
  requestInit?: RequestInit;
  /** Reject non-HTTPS URLs before any request is sent. */
  requireHttps?: boolean;
  /** Optional policy gate for whether this URL is allowed to receive bearer auth. */
  shouldAttachAuth?: (url: string) => boolean;
  /** Override which responses should trigger scoped-token retries. Defaults to 401/403. */
  shouldRetry?: (response: Response) => boolean;
}): Promise<Response> {
  const fetchFn = params.fetchFn ?? fetch;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(params.url);
  } catch {
    throw new Error(`Invalid URL: ${params.url}`);
  }
  if (params.requireHttps === true && parsedUrl.protocol !== "https:") {
    throw new Error(`URL must use HTTPS: ${params.url}`);
  }

  const requestInit = normalizeRequestInitHeadersForFetch(params.requestInit);
  const fetchOnce = (headers?: Headers): Promise<Response> =>
    fetchFn(params.url, {
      ...requestInit,
      ...(headers ? { headers } : {}),
    });

  const firstAttempt = await fetchOnce();
  if (firstAttempt.ok) {
    return firstAttempt;
  }
  if (!params.tokenProvider) {
    return firstAttempt;
  }

  const shouldRetry =
    params.shouldRetry ?? ((response: Response) => isAuthFailureStatus(response.status));
  if (!shouldRetry(firstAttempt)) {
    return firstAttempt;
  }
  if (params.shouldAttachAuth && !params.shouldAttachAuth(params.url)) {
    return firstAttempt;
  }

  for (const scope of params.scopes) {
    try {
      const token = await params.tokenProvider.getAccessToken(scope);
      const authHeaders = new Headers(normalizeHeadersInitForFetch(requestInit?.headers));
      authHeaders.set("Authorization", `Bearer ${token}`);
      const authAttempt = await fetchOnce(authHeaders);
      if (authAttempt.ok) {
        return authAttempt;
      }
      if (!shouldRetry(authAttempt)) {
        continue;
      }
    } catch {
      // Ignore token/fetch errors and continue trying remaining scopes.
    }
  }

  return firstAttempt;
}
