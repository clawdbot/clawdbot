import { withTrustedEnvProxyGuardedFetchMode } from "openclaw/plugin-sdk/fetch-runtime";
import {
  fetchWithSsrFGuard,
  mergeSsrFPolicies,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";

type GuardedFetchResult = Awaited<ReturnType<typeof fetchWithSsrFGuard>>;

export const COPILOT_MODEL_DISCOVERY_ENDPOINT_SOURCE = {
  OPERATOR_OVERRIDE: "operator_override",
  TOKEN_EXCHANGE: "token_exchange",
} as const;

export type CopilotModelDiscoveryEndpointSource =
  (typeof COPILOT_MODEL_DISCOVERY_ENDPOINT_SOURCE)[keyof typeof COPILOT_MODEL_DISCOVERY_ENDPOINT_SOURCE];

export async function fetchCopilotModelDiscovery(params: {
  url: string;
  init: RequestInit;
  endpointSource: CopilotModelDiscoveryEndpointSource;
  fetchImpl?: typeof fetch;
  policy?: SsrFPolicy;
  signal?: AbortSignal;
  timeoutMs?: number;
  auditContext: string;
}): Promise<GuardedFetchResult> {
  const guardedParams = {
    url: params.url,
    init: params.init,
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
    policy:
      params.endpointSource === COPILOT_MODEL_DISCOVERY_ENDPOINT_SOURCE.TOKEN_EXCHANGE
        ? mergeSsrFPolicies(params.policy, ssrfPolicyFromHttpBaseUrlAllowedOrigin(params.url))
        : params.policy,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    auditContext: params.auditContext,
  };
  // Token exchange validates the provider-owned HTTPS endpoint. Operator
  // overrides remain strict because they can point at private or custom hosts.
  return await fetchWithSsrFGuard(
    params.endpointSource === COPILOT_MODEL_DISCOVERY_ENDPOINT_SOURCE.TOKEN_EXCHANGE &&
      new URL(params.url).protocol === "https:"
      ? withTrustedEnvProxyGuardedFetchMode({
          ...guardedParams,
          requireHttps: true,
          // Token-derived endpoints are allowlisted, but the response is
          // optional discovery data. Reject redirects instead of carrying the
          // bearer request through an unscoped environment proxy hop.
          maxRedirects: 0,
        })
      : guardedParams,
  );
}
