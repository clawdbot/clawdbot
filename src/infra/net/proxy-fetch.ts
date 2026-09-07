import { logWarn } from "../../logger.js";
import { formatErrorMessage } from "../errors.js";
import { resolveEnvHttpProxyAgentOptions } from "./proxy-env.js";
import { fetchWithPreparedRuntimeDispatcher } from "./runtime-fetch.js";
import {
  createHttp1EnvHttpProxyAgent,
  createHttp1ProxyAgent,
  loadUndiciRuntimeDeps,
} from "./undici-runtime.js";

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
  let agent: ReturnType<typeof createHttp1ProxyAgent> | null = null;
  const proxyFetch: ProxyFetchWithMetadata = (input, init) => {
    agent ??= createHttp1ProxyAgent({ uri: proxyUrl });
    return fetchWithPreparedRuntimeDispatcher(runtimeDeps, input, {
      ...init,
      dispatcher: agent,
    });
  };
  Object.defineProperty(proxyFetch, PROXY_FETCH_PROXY_URL, {
    value: proxyUrl,
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
  const proxyOptions = resolveEnvHttpProxyAgentOptions(env);
  if (!proxyOptions) {
    return undefined;
  }
  try {
    const runtimeDeps = loadUndiciRuntimeDeps();
    const agent = createHttp1EnvHttpProxyAgent(proxyOptions, undefined, env);
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
