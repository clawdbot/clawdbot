// Memory Host SDK module implements remote http behavior.
import {
  fetchWithSsrFGuard,
  shouldUseEnvHttpProxyForUrl,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "./openclaw-runtime-network.js";
import type { SsrFPolicy } from "./ssrf-policy.js";

// Remote memory HTTP wrapper that applies SSRF policy and releases guarded sockets.

/** Proxy mode used only for URLs that the runtime classified as env-proxy safe. */
const MEMORY_REMOTE_TRUSTED_ENV_PROXY_MODE = "trusted_env_proxy";

/** Build an SSRF allow policy from a configured remote base URL. */
export const buildRemoteBaseUrlPolicy: (baseUrl: string) => SsrFPolicy | undefined =
  ssrfPolicyFromHttpBaseUrlAllowedHostname;

/** Execute a remote HTTP request under SSRF guard and always release the response handle. */
export async function withRemoteHttpResponse<T>(params: {
  url: string;
  init?: RequestInit;
  signal?: AbortSignal;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  fetchWithSsrFGuardImpl?: typeof fetchWithSsrFGuard;
  shouldUseEnvHttpProxyForUrlImpl?: typeof shouldUseEnvHttpProxyForUrl;
  auditContext?: string;
  onResponse: (response: Response) => Promise<T>;
}): Promise<T> {
  const guardedFetch = params.fetchWithSsrFGuardImpl ?? fetchWithSsrFGuard;
  const shouldUseEnvProxy = params.shouldUseEnvHttpProxyForUrlImpl ?? shouldUseEnvHttpProxyForUrl;
  const { response, release } = await guardedFetch({
    url: params.url,
    fetchImpl: params.fetchImpl,
    init: params.init,
    signal: params.signal,
    policy: params.ssrfPolicy,
    auditContext: params.auditContext ?? "memory-remote",
    ...(shouldUseEnvProxy(params.url) ? { mode: MEMORY_REMOTE_TRUSTED_ENV_PROXY_MODE } : {}),
  });
  try {
    return await params.onResponse(response);
  } finally {
    await release();
  }
}
