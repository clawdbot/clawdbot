// Public fetch/proxy helpers for plugins that need wrapped fetch behavior.

import type { GuardedFetchOptions } from "../infra/net/fetch-guard.js";

export { resolveFetch, wrapFetchWithAbortSignal } from "../infra/fetch.js";
export {
  createHttp1EnvHttpProxyAgent,
  createHttp1ProxyAgent,
} from "../infra/net/undici-runtime.js";
export {
  addActiveManagedProxyTlsOptions,
  resolveActiveManagedProxyTlsOptions,
} from "../infra/net/proxy/managed-proxy-undici.js";
export {
  createNodeProxyAgent,
  type CreateNodeProxyAgentOptions,
} from "../infra/net/node-proxy-agent.js";
export {
  hasEnvHttpProxyConfigured,
  hasEnvHttpProxyAgentConfigured,
  matchesNoProxy,
  resolveEnvHttpProxyAgentOptions,
  resolveEnvHttpProxyUrl,
  shouldUseEnvHttpProxyForUrl,
} from "../infra/net/proxy-env.js";
export { getProxyUrlFromFetch, makeProxyFetch } from "../infra/net/proxy-fetch.js";
export { createPinnedLookup } from "../infra/net/ssrf.js";
export type { PinnedDispatcherPolicy } from "../infra/net/ssrf.js";

type GuardedFetchPresetOptions = Omit<
  GuardedFetchOptions,
  "mode" | "proxy" | "dangerouslyAllowEnvProxyWithoutPinnedDns"
>;

/** Apply the trusted-env-proxy guarded fetch preset without exposing raw mode strings to plugins. */
export function withTrustedEnvProxyGuardedFetchMode(
  params: GuardedFetchPresetOptions,
): GuardedFetchOptions {
  return { ...params, mode: "trusted_env_proxy" };
}
