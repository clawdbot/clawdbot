/**
 * MCP HTTP fetch wrappers.
 * Adds SSRF protection, scoped TLS/client-cert dispatchers, response cleanup,
 * and same-origin header handling around the MCP SDK fetch contract.
 */
import fs from "node:fs";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import {
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
  type PinnedDispatcherPolicy,
} from "../infra/net/ssrf.js";
import { loadUndiciRuntimeDeps } from "../infra/net/undici-runtime.js";

/** MCP SDK-compatible fetch function type. */
export type { FetchLike };

/** Default MCP HTTP fetch backed by lazy-loaded undici runtime deps. */
export const fetchWithUndici: FetchLike = async (url, init) =>
  (await loadUndiciRuntimeDeps().fetch(
    url,
    init as Parameters<ReturnType<typeof loadUndiciRuntimeDeps>["fetch"]>[1],
  )) as unknown as Response;

const fetchWithUndiciGuard = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => await fetchWithUndici(input instanceof Request ? input.url : input, init);

const MCP_HTTP_MAX_REDIRECTS = 20;
const managedMcpResponseCleanupRegistry = new FinalizationRegistry<{
  finalize: () => Promise<void>;
}>((held) => {
  void held.finalize();
});

function resolveFetchRequest(input: RequestInfo | URL, init?: RequestInit) {
  if (input instanceof Request) {
    const request = new Request(input, init);
    const body = request.body ?? undefined;
    return {
      url: request.url,
      init: {
        method: request.method,
        headers: request.headers,
        body,
        redirect: request.redirect,
        signal: request.signal,
        ...(body ? ({ duplex: "half" } as const) : {}),
      } satisfies RequestInit & { duplex?: "half" },
    };
  }
  return {
    url: input instanceof URL ? input.toString() : input,
    init,
  };
}

function buildManagedMcpResponse(
  response: Response,
  release: () => Promise<void>,
  refreshTimeout?: () => void,
): Response {
  if (!response.body) {
    void release();
    return response;
  }

  const source = response.body;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let released = false;
  const cleanupRegistrationToken = {};
  const finalize = async () => {
    if (released) {
      return;
    }
    released = true;
    managedMcpResponseCleanupRegistry.unregister(cleanupRegistrationToken);
    await reader?.cancel().catch(() => undefined);
    await release().catch(() => undefined);
  };
  const wrappedBody = new ReadableStream<Uint8Array>({
    start() {
      reader = source.getReader();
    },
    async pull(controller) {
      try {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) {
          controller.close();
          await finalize();
          return;
        }
        refreshTimeout?.();
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
        await finalize();
      }
    },
    async cancel(reason) {
      try {
        await reader?.cancel(reason);
      } finally {
        await finalize();
      }
    },
  });
  managedMcpResponseCleanupRegistry.register(wrappedBody, { finalize }, cleanupRegistrationToken);
  return new Response(wrappedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Builds an MCP fetch function with optional TLS/client-cert dispatcher support. */
export function buildMcpHttpFetch(params: {
  sslVerify?: boolean;
  clientCert?: string;
  clientKey?: string;
  resourceUrl?: string;
}): FetchLike {
  const needsCustomDispatcher =
    params.sslVerify === false || Boolean(params.clientCert || params.clientKey);
  const scopedOrigin = params.resourceUrl ? new URL(params.resourceUrl).origin : undefined;
  const policy = params.resourceUrl
    ? ssrfPolicyFromHttpBaseUrlAllowedOrigin(params.resourceUrl)
    : undefined;

  let customConnect: Record<string, unknown> | undefined;
  const resolveCustomDispatcherPolicy = (url: URL): PinnedDispatcherPolicy | undefined => {
    if (!needsCustomDispatcher || !scopedOrigin || url.origin !== scopedOrigin) {
      return undefined;
    }
    customConnect ??= {
      ...(params.sslVerify === false ? { rejectUnauthorized: false } : {}),
      ...(params.clientCert ? { cert: fs.readFileSync(params.clientCert, "utf-8") } : {}),
      ...(params.clientKey ? { key: fs.readFileSync(params.clientKey, "utf-8") } : {}),
    };
    return { mode: "direct", connect: customConnect };
  };

  return async (url, init) => {
    const request = resolveFetchRequest(url, init);
    const guardedFetchOptions = {
      url: request.url,
      init: request.init,
      fetchImpl: fetchWithUndiciGuard,
      maxRedirects: MCP_HTTP_MAX_REDIRECTS,
      allowCrossOriginUnsafeRedirectReplay: true,
      auditContext: "mcp-http",
      useEnvProxyForEligibleUrls: true,
      ...(policy ? { policy } : {}),
      ...(needsCustomDispatcher ? { resolveDispatcherPolicy: resolveCustomDispatcherPolicy } : {}),
    };
    const guarded = await fetchWithSsrFGuard(guardedFetchOptions);
    return buildManagedMcpResponse(guarded.response, guarded.release, guarded.refreshTimeout);
  };
}

/** Removes Authorization from MCP headers before forwarding to non-authorized paths. */
export function withoutMcpAuthorizationHeader(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const entries = Object.entries(headers).filter(([key]) => key.toLowerCase() !== "authorization");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Wraps MCP fetch so configured headers are applied only to the resource origin. */
export function withSameOriginMcpHttpHeaders(params: {
  fetchFn: FetchLike;
  headers: Record<string, string> | undefined;
  resourceUrl: string;
}): FetchLike {
  if (!params.headers || Object.keys(params.headers).length === 0) {
    return params.fetchFn;
  }
  const resourceOrigin = new URL(params.resourceUrl).origin;
  return (url, init) => {
    if (new URL(url).origin !== resourceOrigin) {
      return params.fetchFn(url, init);
    }
    const headers = new Headers(params.headers);
    for (const [key, value] of new Headers(init?.headers)) {
      headers.set(key, value);
    }
    return params.fetchFn(url, { ...(init as RequestInit), headers });
  };
}
