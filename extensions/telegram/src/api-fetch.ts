// Telegram plugin module implements api fetch behavior.
import type { TelegramNetworkConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { resolveTelegramApiBase, resolveTelegramFetch, resolveTelegramTransport } from "./fetch.js";
import { makeProxyFetch } from "./proxy.js";
import { resolveTelegramRequestTimeoutMs } from "./request-timeouts.js";

const TELEGRAM_BOT_API_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

type TelegramGetChatResponse = {
  ok?: boolean;
  result?: { id?: number | string };
};

// Shipped runtime API. Internal one-shot callers use resolveTelegramTransport
// directly so they can close the dispatcher after the response body settles.
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
  timeoutSeconds?: unknown;
}): Promise<string | null> {
  const proxyUrl = params.proxyUrl?.trim();
  const proxyFetch = proxyUrl ? makeProxyFetch(proxyUrl) : undefined;
  const transport = resolveTelegramTransport(proxyFetch, { network: params.network });
  try {
    return await fetchTelegramChatId({
      token: params.token,
      chatId: params.chatId,
      signal: params.signal,
      apiRoot: params.apiRoot,
      timeoutSeconds: params.timeoutSeconds,
      fetchImpl: transport.fetch,
    });
  } finally {
    await transport.close();
  }
}

export async function fetchTelegramChatId(params: {
  token: string;
  chatId: string;
  signal?: AbortSignal;
  apiRoot?: string;
  fetchImpl?: typeof fetch;
  timeoutSeconds?: unknown;
}): Promise<string | null> {
  const apiBase = resolveTelegramApiBase(params.apiRoot);
  const url = `${apiBase}/bot${params.token}/getChat?chat_id=${encodeURIComponent(params.chatId)}`;
  const fetchImpl = params.fetchImpl ?? fetch;
  const requestAbortController = new AbortController();
  const requestSignal = params.signal
    ? AbortSignal.any([params.signal, requestAbortController.signal])
    : requestAbortController.signal;
  const timeout = buildTimeoutAbortSignal({
    signal: requestSignal,
    timeoutMs: resolveTelegramRequestTimeoutMs("getchat", params.timeoutSeconds),
    operation: "telegram-getchat-lookup",
    url,
  });
  try {
    const res = await fetchImpl(url, timeout.signal ? { signal: timeout.signal } : undefined);
    if (!res.ok) {
      requestAbortController.abort(new Error(`Telegram getChat failed with HTTP ${res.status}`));
      void res.body?.cancel().catch(() => undefined);
      return null;
    }
    let data: TelegramGetChatResponse | null = null;
    try {
      data = JSON.parse(
        (await readResponseWithLimit(res, TELEGRAM_BOT_API_MAX_RESPONSE_BYTES)).toString("utf8"),
      ) as TelegramGetChatResponse;
    } catch {
      return null;
    }
    const id = data?.ok ? data?.result?.id : undefined;
    if (typeof id === "number" || typeof id === "string") {
      return String(id);
    }
    return null;
  } catch {
    return null;
  } finally {
    timeout.cleanup();
  }
}
