import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { Dispatcher } from "undici";

import type { ZaloFetch } from "./api.js";

const proxyCache = new Map<string, ZaloFetch>();

export function resolveZaloProxyFetch(proxyUrl?: string | null): ZaloFetch | undefined {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) return undefined;
  const cached = proxyCache.get(trimmed);
  if (cached) return cached;
  const agent = new ProxyAgent(trimmed);
  const fetcher: ZaloFetch = (input, init) =>
    undiciFetch(input, { ...(init ?? {}), dispatcher: agent as Dispatcher });
  proxyCache.set(trimmed, fetcher);
  return fetcher;
}
