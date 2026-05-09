import { fetchWithTimeoutGuarded } from "openclaw/plugin-sdk/provider-http";

type GuardedFetchResult = Awaited<ReturnType<typeof fetchWithTimeoutGuarded>>;
type FetchGuardOptions = NonNullable<Parameters<typeof fetchWithTimeoutGuarded>[4]>;
export type OpenRouterVideoDispatcherPolicy = FetchGuardOptions["dispatcherPolicy"];

function headersForOpenRouterGet(url: string, baseUrl: string, requestHeaders: Headers): Headers {
  try {
    if (new URL(url).origin !== new URL(baseUrl).origin) {
      return new Headers();
    }
  } catch {
    return new Headers();
  }
  const headers = new Headers(requestHeaders);
  headers.delete("content-type");
  return headers;
}

export function resolveOpenRouterVideoUrl(url: string, baseUrl: string): string {
  return new URL(url, `${baseUrl}/`).href;
}

export async function fetchOpenRouterVideoGet(params: {
  url: string;
  baseUrl: string;
  headers: Headers;
  timeoutMs: number;
  allowPrivateNetwork: boolean;
  dispatcherPolicy: OpenRouterVideoDispatcherPolicy;
  auditContext: string;
}): Promise<GuardedFetchResult> {
  const url = resolveOpenRouterVideoUrl(params.url, params.baseUrl);
  return await fetchWithTimeoutGuarded(
    url,
    {
      method: "GET",
      headers: headersForOpenRouterGet(url, params.baseUrl, params.headers),
    },
    params.timeoutMs,
    fetch,
    {
      ...(params.allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : {}),
      ...(params.dispatcherPolicy ? { dispatcherPolicy: params.dispatcherPolicy } : {}),
      auditContext: params.auditContext,
    },
  );
}
