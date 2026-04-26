import { fetchWithSsrFGuard, GUARDED_FETCH_MODE } from "../../../../src/infra/net/fetch-guard.js";
import { shouldUseEnvHttpProxyForUrl } from "../../../../src/infra/net/proxy-env.js";
import type { SsrFPolicy } from "../../../../src/infra/net/ssrf.js";

export function buildRemoteBaseUrlPolicy(baseUrl: string): SsrFPolicy | undefined {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    // Keep policy tied to the configured host so private operator endpoints
    // continue to work, while cross-host redirects stay blocked.
    return { allowedHostnames: [parsed.hostname] };
  } catch {
    return undefined;
  }
}

export async function withRemoteHttpResponse<T>(params: {
  url: string;
  init?: RequestInit;
  ssrfPolicy?: SsrFPolicy;
  auditContext?: string;
  onResponse: (response: Response) => Promise<T>;
}): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    init: params.init,
    policy: params.ssrfPolicy,
    auditContext: params.auditContext ?? "memory-remote",
    ...(shouldUseEnvHttpProxyForUrl(params.url)
      ? { mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY }
      : {}),
  });
  try {
    return await params.onResponse(response);
  } finally {
    await release();
  }
}
