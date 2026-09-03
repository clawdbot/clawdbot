// Public fetch/proxy helpers for plugins that need wrapped fetch behavior.

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
export { withTrustedEnvProxyGuardedFetchMode } from "../infra/net/fetch-guard.js";

export function responseWithRelease(
  response: Response,
  owner: { kind: "transport" | "after-body"; release: () => Promise<void> | void },
): Response {
  if (!response.body) {
    void Promise.resolve()
      .then(owner.release)
      .catch(() => undefined);
    return response;
  }

  const reader = response.body.getReader();
  let completion: Promise<void> | undefined;
  // Publish completion before callbacks: cancellation closes pending reads
  // before its underlying cleanup settles, so pull must join the same work.
  const finalize = (cancel?: () => Promise<void>) =>
    (completion ??= Promise.resolve().then(async () => {
      const cancellation = cancel?.().catch(() => undefined);
      reader.releaseLock();
      const cleanup = (async () => {
        // Transport release aborts retained capture tees; deadline/listener
        // cleanup must instead stay armed until body cancellation settles.
        if (owner.kind === "after-body") {
          await cancellation;
        }
        await owner.release();
      })();
      const [, released] = await Promise.allSettled([cancellation, cleanup]);
      if (released.status === "rejected") {
        throw released.reason;
      }
    }));
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (completion) {
          return await completion;
        }
        if (!next.done) {
          controller.enqueue(next.value);
          return;
        }
        controller.close();
      } catch (error) {
        if (!completion) {
          await finalize();
          throw error;
        }
      }
      await finalize();
    },
    cancel(reason) {
      return finalize(() => reader.cancel(reason));
    },
  });

  return new Response(body, response);
}
