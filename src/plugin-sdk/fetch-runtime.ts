// Public fetch/proxy helpers for plugins that need wrapped fetch behavior.

export { resolveFetch, wrapFetchWithAbortSignal } from "../infra/fetch.js";
export { withTrustedEnvProxyGuardedFetchMode } from "../infra/net/fetch-guard.ts";
export {
  hasEnvHttpProxyConfigured,
  hasEnvHttpProxyAgentConfigured,
  resolveEnvHttpProxyAgentOptions,
  resolveEnvHttpProxyUrl,
  shouldUseEnvHttpProxyForUrl,
} from "../infra/net/proxy-env.js";
export { getProxyUrlFromFetch, makeProxyFetch } from "../infra/net/proxy-fetch.js";
export { createPinnedLookup } from "../infra/net/ssrf.js";
export type { PinnedDispatcherPolicy } from "../infra/net/ssrf.js";
