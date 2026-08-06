/**
 * MCP HTTP fetch wrappers.
 * Adds SSRF protection, scoped TLS/client-cert dispatchers, response cleanup,
 * and same-origin header handling around the MCP SDK fetch contract.
 */
import fs from "node:fs";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { wrapGuardedBodyStream } from "../infra/net/guarded-body-stream.js";
import {
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
  type PinnedDispatcherPolicy,
} from "../infra/net/ssrf.js";
import { loadUndiciRuntimeDeps } from "../infra/net/undici-runtime.js";

/** Default MCP HTTP fetch backed by lazy-loaded undici runtime deps. */
const fetchWithUndici: FetchLike = async (url, init) =>
  (await loadUndiciRuntimeDeps().fetch(
    url,
    init as Parameters<ReturnType<typeof loadUndiciRuntimeDeps>["fetch"]>[1],
  )) as unknown as Response;

const fetchWithUndiciGuard = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => await fetchWithUndici(input instanceof Request ? input.url : input, init);

const MCP_HTTP_MAX_REDIRECTS = 20;

function resolveFetchRequest(input: RequestInfo | URL, init?: RequestInit) {
  if (input instanceof Request) {
    const request = new Request(input, init);
    const body = request.body ?? undefined;
    return {
      url: request.url,
      signal: request.signal,
      init: {
        method: request.method,
        headers: request.headers,
        body,
        redirect: request.redirect,
        ...(body ? ({ duplex: "half" } as const) : {}),
      } satisfies RequestInit & { duplex?: "half" },
    };
  }
  const { signal, ...requestInit } = init ?? {};
  return {
    url: input instanceof URL ? input.toString() : input,
    signal: signal ?? undefined,
    init: init ? requestInit : undefined,
  };
}

async function ensureGlobalFetchResponse(response: Response): Promise<Response> {
  const init = {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  };
  if (response.body != null) {
    return new Response(response.body, init);
  }
  if (response.status === 204 || response.status === 205 || response.status === 304) {
    return new Response(null, init);
  }
  // A body-less foreign Response exposes no bounded reader. Calling text() or
  // arrayBuffer() can allocate an attacker-controlled body before any cap applies.
  return new Response(null, init);
}

async function buildManagedMcpResponse(
  response: Response,
  release: () => Promise<void>,
  refreshTimeout?: () => void,
): Promise<Response> {
  if (!response.body) {
    void release();
    return await ensureGlobalFetchResponse(response);
  }

  const wrappedBody = wrapGuardedBodyStream({
    body: response.body,
    cleanup: release,
    refreshTimeout,
  });
  return await ensureGlobalFetchResponse(
    new Response(wrappedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  );
}

/** Builds an MCP fetch function with optional TLS/client-cert dispatcher support. */
export function buildMcpHttpFetch(params: {
  sslVerify?: boolean;
  clientCert?: string;
  clientKey?: string;
  resourceUrl?: string;
  timeoutMs?: number;
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
      ...(request.signal ? { signal: request.signal } : {}),
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
      ...(policy ? { policy } : {}),
      ...(needsCustomDispatcher ? { resolveDispatcherPolicy: resolveCustomDispatcherPolicy } : {}),
    };
    const guarded = await fetchWithSsrFGuard(guardedFetchOptions);
    return await buildManagedMcpResponse(guarded.response, guarded.release, guarded.refreshTimeout);
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
