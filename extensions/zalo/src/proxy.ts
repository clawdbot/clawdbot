import { makeProxyFetch } from "openclaw/plugin-sdk/fetch-runtime";
import type { ZaloFetch } from "./api.js";

const proxyCache = new Map<string, ZaloFetch>();

export function resolveZaloProxyFetch(proxyUrl?: string | null): ZaloFetch | undefined {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) {
    return undefined;
  }
  const cached = proxyCache.get(trimmed);
  if (cached) {
    return cached;
  }
  const fetcher = makeProxyFetch(trimmed) as ZaloFetch;
  proxyCache.set(trimmed, fetcher);
  return fetcher;
}
