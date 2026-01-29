import type { Dispatcher } from "undici";
import { ProxyAgent } from "undici";
import { wrapFetchWithAbortSignal } from "../infra/fetch.js";

type FetchInit = RequestInit & { dispatcher?: Dispatcher };

export function makeProxyFetch(proxyUrl: string): typeof fetch {
  const agent = new ProxyAgent(proxyUrl);
  return wrapFetchWithAbortSignal((input: RequestInfo | URL, init?: RequestInit) => {
    const base = init ? { ...init } : {};
    const nextInit: FetchInit = { ...base, dispatcher: agent };
    return fetch(input, nextInit);
  });
}
