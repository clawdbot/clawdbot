import fs from "node:fs";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { loadUndiciRuntimeDeps } from "../infra/net/undici-runtime.js";

export type { FetchLike };

export const fetchWithUndici: FetchLike = async (url, init) =>
  (await loadUndiciRuntimeDeps().fetch(
    url,
    init as Parameters<ReturnType<typeof loadUndiciRuntimeDeps>["fetch"]>[1],
  )) as unknown as Response;

export function buildMcpHttpFetch(params: {
  sslVerify?: boolean;
  clientCert?: string;
  clientKey?: string;
  resourceUrl?: string;
}): FetchLike {
  const needsCustomDispatcher =
    params.sslVerify === false || Boolean(params.clientCert || params.clientKey);
  if (!needsCustomDispatcher) {
    return fetchWithUndici;
  }
  const scopedOrigin = params.resourceUrl ? new URL(params.resourceUrl).origin : undefined;

  const buildDispatcher = () => {
    const { Agent } = loadUndiciRuntimeDeps();
    return new Agent({
      connect: {
        ...(params.sslVerify === false ? { rejectUnauthorized: false } : {}),
        ...(params.clientCert ? { cert: fs.readFileSync(params.clientCert, "utf-8") } : {}),
        ...(params.clientKey ? { key: fs.readFileSync(params.clientKey, "utf-8") } : {}),
      },
    });
  };

  let dispatcher: unknown;
  return async (url, init) => {
    if (scopedOrigin && new URL(url).origin !== scopedOrigin) {
      return fetchWithUndici(url, init);
    }
    dispatcher ??= buildDispatcher();
    return (await loadUndiciRuntimeDeps().fetch(url, {
      ...(init as RequestInit),
      dispatcher,
    } as Parameters<ReturnType<typeof loadUndiciRuntimeDeps>["fetch"]>[1])) as unknown as Response;
  };
}

export function withoutMcpAuthorizationHeader(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const entries = Object.entries(headers).filter(([key]) => key.toLowerCase() !== "authorization");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

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
