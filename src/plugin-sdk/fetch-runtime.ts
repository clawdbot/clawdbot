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

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

export function responseWithRelease(response: Response, release: () => Promise<void>): Response {
  let released = false;
  // Upstream cancellation closes pending reads before its async cleanup settles.
  // Coordinate both paths so neither can release the transport early.
  let canceling: Promise<void> | undefined;
  const releaseOnce = async () => {
    if (released) {
      return;
    }
    released = true;
    await release();
  };

  if (!response.body || NULL_BODY_STATUSES.has(response.status)) {
    void releaseOnce();
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (canceling) {
          await canceling;
          await releaseOnce();
          return;
        }
        if (next.done) {
          controller.close();
          await releaseOnce();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        if (canceling) {
          await canceling;
          await releaseOnce();
          return;
        }
        await releaseOnce();
        throw error;
      }
    },
    async cancel(reason) {
      canceling = reader.cancel(reason).catch(() => undefined);
      await canceling;
      await releaseOnce();
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Apply the trusted-env-proxy guarded fetch preset without exposing raw mode strings to plugins. */
export function withTrustedEnvProxyGuardedFetchMode(
  params: GuardedFetchPresetOptions,
): GuardedFetchOptions {
  return { ...params, mode: "trusted_env_proxy" };
}
