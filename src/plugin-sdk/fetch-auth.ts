import {
  normalizeHeadersInitForFetch,
  normalizeRequestInitHeadersForFetch,
} from "../infra/fetch-headers.js";

export type ScopeTokenProvider = {
  getAccessToken: (scope: string) => Promise<string>;
};

function isAuthFailureStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/** Retry a fetch with bearer tokens from the provided scopes when the unauthenticated attempt fails. */
export async function fetchWithBearerAuthScopeFallback(params: {
  url: string;
  scopes: readonly string[];
  tokenProvider?: ScopeTokenProvider;
  fetchFn?: typeof fetch;
  requestInit?: RequestInit;
  requireHttps?: boolean;
  shouldAttachAuth?: (url: string) => boolean;
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
