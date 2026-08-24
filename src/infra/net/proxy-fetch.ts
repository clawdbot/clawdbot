// Proxy fetch helpers build undici proxy-aware fetch functions with managed TLS
// options and runtime FormData normalization.
import { logWarn } from "../../logger.js";
import { formatErrorMessage } from "../errors.js";
import { resolveManagedEnvHttpProxyAgentOptions } from "./proxy/managed-proxy-undici.js";
import { fetchWithPreparedRuntimeDispatcher } from "./runtime-fetch.js";
import {
  buildHttp1EnvHttpProxyAgentOptions,
  buildHttp1ProxyAgentOptions,
} from "./undici-dispatcher-options.js";
import { withUndiciErrorDiagnostics } from "./undici-error-diagnostics.js";
import { loadUndiciRuntimeDeps } from "./undici-runtime.js";

/** Non-enumerable marker used to recover the explicit proxy URL from proxy fetch wrappers. */
export const PROXY_FETCH_PROXY_URL = Symbol.for("openclaw.proxyFetch.proxyUrl");
type ProxyFetchWithMetadata = typeof fetch & {
  [PROXY_FETCH_PROXY_URL]?: string;
};

/**
 * Create a fetch function that routes requests through the given HTTP proxy.
 * Uses undici's ProxyAgent under the hood.
 */
export function makeProxyFetch(proxyUrl: string): typeof fetch {
  const runtimeDeps = loadUndiciRuntimeDeps();
  const { ProxyAgent } = runtimeDeps;
  let agent: InstanceType<typeof ProxyAgent> | null = null;
  const resolveAgent = (): InstanceType<typeof ProxyAgent> => {
    if (!agent) {
      agent = withUndiciErrorDiagnostics(
        new ProxyAgent(buildHttp1ProxyAgentOptions({ uri: proxyUrl })),
      );
    }
    return agent;
  };
  const proxyFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchWithPreparedRuntimeDispatcher(runtimeDeps, input, {
      ...init,
      dispatcher: resolveAgent(),
    })) as ProxyFetchWithMetadata;
  Object.defineProperty(proxyFetch, PROXY_FETCH_PROXY_URL, {
    value: proxyUrl,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return proxyFetch;
}

/** Return the explicit proxy URL attached by {@link makeProxyFetch}, if present. */
export function getProxyUrlFromFetch(fetchImpl?: typeof fetch): string | undefined {
  const proxyUrl = (fetchImpl as ProxyFetchWithMetadata | undefined)?.[PROXY_FETCH_PROXY_URL];
  if (typeof proxyUrl !== "string") {
    return undefined;
  }
  const trimmed = proxyUrl.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve a proxy-aware fetch from standard environment variables.
 * Respects NO_PROXY / no_proxy exclusions via undici's EnvHttpProxyAgent.
 * Returns undefined when no proxy is configured.
 * Gracefully returns undefined if the proxy URL is malformed.
 */
export function resolveProxyFetchFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): typeof fetch | undefined {
  const proxyOptions = resolveManagedEnvHttpProxyAgentOptions(env);
  if (!proxyOptions) {
    return undefined;
  }
  try {
    const runtimeDeps = loadUndiciRuntimeDeps();
    const { EnvHttpProxyAgent } = runtimeDeps;
    const agent = withUndiciErrorDiagnostics(
      new EnvHttpProxyAgent(buildHttp1EnvHttpProxyAgentOptions(proxyOptions)),
    );
    return ((input: RequestInfo | URL, init?: RequestInit) =>
      fetchWithPreparedRuntimeDispatcher(runtimeDeps, input, {
        ...init,
        dispatcher: agent,
      })) as typeof fetch;
  } catch (err) {
    logWarn(
      `Proxy env var set but agent creation failed — falling back to direct fetch: ${formatErrorMessage(err)}`,
    );
    return undefined;
  }
}
