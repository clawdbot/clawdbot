import type { TelegramNetworkConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveTelegramApiBase, resolveTelegramFetch } from "./fetch.js";
import { makeProxyFetch } from "./proxy.js";

export function resolveTelegramChatLookupFetch(params?: {
  proxyUrl?: string;
  network?: TelegramNetworkConfig;
}): typeof fetch {
  const proxyUrl = params?.proxyUrl?.trim();
  const proxyFetch = proxyUrl ? makeProxyFetch(proxyUrl) : undefined;
  return resolveTelegramFetch(proxyFetch, { network: params?.network });
}

export async function lookupTelegramChatId(params: {
  token: string;
  chatId: string;
  signal?: AbortSignal;
  apiRoot?: string;
  proxyUrl?: string;
  network?: TelegramNetworkConfig;
}): Promise<string | null> {
  return fetchTelegramChatId({
    token: params.token,
    chatId: params.chatId,
    signal: params.signal,
    apiRoot: params.apiRoot,
    fetchImpl: resolveTelegramChatLookupFetch({
      proxyUrl: params.proxyUrl,
      network: params.network,
    }),
  });
}

export async function fetchTelegramChatId(params: {
  token: string;
  chatId: string;
  signal?: AbortSignal;
  apiRoot?: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const apiBase = resolveTelegramApiBase(params.apiRoot);
  const url = `${apiBase}/bot${params.token}/getChat?chat_id=${encodeURIComponent(params.chatId)}`;
  const fetchImpl = params.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(url, params.signal ? { signal: params.signal } : undefined);
    if (!res.ok) {
      return null;
    }
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: { id?: number | string };
    } | null;
    const id = data?.ok ? data?.result?.id : undefined;
    if (typeof id === "number" || typeof id === "string") {
      return String(id);
    }
    return null;
  } catch {
    return null;
  }
}
