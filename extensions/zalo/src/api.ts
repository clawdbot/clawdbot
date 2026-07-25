/**
 * Zalo Bot API client
 * @see https://bot.zaloplatforms.com/docs
 */

import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { resolvePinnedHostnameWithPolicy, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { ZALO_DEFAULT_REQUEST_TIMEOUT_MS, ZALO_SEND_PHOTO_REQUEST_TIMEOUT_MS } from "./timeouts.js";

const ZALO_API_BASE = "https://bot-api.zaloplatforms.com";
const ZALO_API_URL_ENV = "ZALO_API_URL";
const ZALO_MEDIA_SSRF_POLICY: SsrFPolicy = {};

export type ZaloFetch = (input: string, init?: RequestInit) => Promise<Response>;

type ZaloApiResponse<T = unknown> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
};

export type ZaloBotInfo = {
  id: string;
  account_name: string;
  account_type: string;
  can_join_groups: boolean;
};

export type ZaloMessage = {
  message_id: string;
  from: {
    id: string;
    name?: string;
    display_name?: string;
    avatar?: string;
    is_bot?: boolean;
  };
  chat: {
    id: string;
    chat_type: "PRIVATE" | "GROUP";
  };
  date: number;
  text?: string;
  photo_url?: string;
  caption?: string;
  sticker?: string;
  message_type?: string;
};

export type ZaloUpdate = {
  event_name:
    | "message.text.received"
    | "message.image.received"
    | "message.sticker.received"
    | "message.unsupported.received";
  message?: ZaloMessage;
};

type ZaloSendMessageParams = {
  chat_id: string;
  text: string;
};

type ZaloSendPhotoParams = {
  chat_id: string;
  photo: string;
  caption?: string;
};

type ZaloSendChatActionParams = {
  chat_id: string;
  action: "typing" | "upload_photo";
};

type ZaloSetWebhookParams = {
  url: string;
  secret_token: string;
};

type ZaloWebhookInfo = {
  url?: string;
  updated_at?: number;
  has_custom_certificate?: boolean;
};

type ZaloGetUpdatesParams = {
  /** Timeout in seconds (passed as string to API) */
  timeout?: number;
};

export class ZaloApiError extends Error {
  constructor(
    message: string,
    public readonly errorCode?: number,
    public readonly description?: string,
  ) {
    super(message);
    this.name = "ZaloApiError";
  }

  /** True if this is a long-polling timeout (no updates available) */
  get isPollingTimeout(): boolean {
    return this.errorCode === 408;
  }
}

function resolveZaloApiUrl(apiUrl?: string): string {
  const value =
    apiUrl === undefined ? (process.env[ZALO_API_URL_ENV]?.trim() ?? ZALO_API_BASE) : apiUrl.trim();
  if (!value) {
    throw new Error(`${ZALO_API_URL_ENV} must not be empty.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${ZALO_API_URL_ENV} must be a valid URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${ZALO_API_URL_ENV} must use http:// or https://.`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${ZALO_API_URL_ENV} must not include a query string or fragment.`);
  }
  return parsed.href.replace(/\/+$/u, "");
}

/**
 * Call the Zalo Bot API
 */
export async function callZaloApi<T = unknown>(
  method: string,
  token: string,
  body?: Record<string, unknown>,
  options?: { apiUrl?: string; timeoutMs?: number; fetch?: ZaloFetch },
): Promise<ZaloApiResponse<T>> {
  const url = `${resolveZaloApiUrl(options?.apiUrl)}/bot${token}/${method}`;
  const controller = new AbortController();
  const requestTimeoutMs = resolveTimerTimeoutMs(
    options?.timeoutMs,
    ZALO_DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
  const fetcher = options?.fetch ?? fetch;

  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const data = await readProviderJsonResponse<ZaloApiResponse<T>>(response, `zalo.${method}`);

    if (!data.ok) {
      throw new ZaloApiError(
        data.description ?? `Zalo API error: ${method}`,
        data.error_code,
        data.description,
      );
    }

    return data;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Validate bot token and get bot info
 */
export async function getMe(
  token: string,
  timeoutMs?: number,
  fetcher?: ZaloFetch,
): Promise<ZaloApiResponse<ZaloBotInfo>> {
  return callZaloApi<ZaloBotInfo>("getMe", token, undefined, { timeoutMs, fetch: fetcher });
}

/**
 * Send a text message
 */
export async function sendMessage(
  token: string,
  params: ZaloSendMessageParams,
  fetcher?: ZaloFetch,
): Promise<ZaloApiResponse<ZaloMessage>> {
  return callZaloApi<ZaloMessage>("sendMessage", token, params, { fetch: fetcher });
}

/**
 * Send a photo message
 */
export async function sendPhoto(
  token: string,
  params: ZaloSendPhotoParams,
  fetcher?: ZaloFetch,
): Promise<ZaloApiResponse<ZaloMessage>> {
  const photoUrl = params.photo.trim();
  let parsedPhotoUrl: URL;
  try {
    parsedPhotoUrl = new URL(photoUrl);
  } catch {
    throw new Error("Zalo photo URL must be an absolute HTTP or HTTPS URL");
  }

  if (parsedPhotoUrl.protocol !== "http:" && parsedPhotoUrl.protocol !== "https:") {
    throw new Error("Zalo photo URL must use HTTP or HTTPS");
  }

  await resolvePinnedHostnameWithPolicy(parsedPhotoUrl.hostname, {
    policy: ZALO_MEDIA_SSRF_POLICY,
  });

  return callZaloApi<ZaloMessage>(
    "sendPhoto",
    token,
    { ...params, photo: parsedPhotoUrl.href },
    {
      // Zalo receives a URL-only JSON body and may resolve that URL before replying.
      // Wait through the hosted-media lifetime plus normal response-processing grace.
      timeoutMs: ZALO_SEND_PHOTO_REQUEST_TIMEOUT_MS,
      fetch: fetcher,
    },
  );
}

/**
 * Send a temporary chat action such as typing.
 */
export async function sendChatAction(
  token: string,
  params: ZaloSendChatActionParams,
  fetcher?: ZaloFetch,
  timeoutMs?: number,
): Promise<ZaloApiResponse<boolean>> {
  return callZaloApi<boolean>("sendChatAction", token, params, {
    timeoutMs,
    fetch: fetcher,
  });
}

/**
 * Get updates using long polling (dev/testing only)
 * Note: Zalo returns a single update per call, not an array like Telegram
 */
export async function getUpdates(
  token: string,
  params?: ZaloGetUpdatesParams,
  fetcher?: ZaloFetch,
): Promise<ZaloApiResponse<ZaloUpdate>> {
  const pollTimeoutSec = params?.timeout ?? 30;
  const timeoutMs = (pollTimeoutSec + 5) * 1000;
  const body = { timeout: String(pollTimeoutSec) };
  return callZaloApi<ZaloUpdate>("getUpdates", token, body, { timeoutMs, fetch: fetcher });
}

/**
 * Set webhook URL for receiving updates
 */
export async function setWebhook(
  token: string,
  params: ZaloSetWebhookParams,
  fetcher?: ZaloFetch,
): Promise<ZaloApiResponse<ZaloWebhookInfo>> {
  return callZaloApi<ZaloWebhookInfo>("setWebhook", token, params, { fetch: fetcher });
}

/**
 * Delete webhook configuration
 */
export async function deleteWebhook(
  token: string,
  fetcher?: ZaloFetch,
  timeoutMs?: number,
): Promise<ZaloApiResponse<ZaloWebhookInfo>> {
  return callZaloApi<ZaloWebhookInfo>("deleteWebhook", token, undefined, {
    timeoutMs,
    fetch: fetcher,
  });
}

/**
 * Get current webhook info
 */
export async function getWebhookInfo(
  token: string,
  fetcher?: ZaloFetch,
): Promise<ZaloApiResponse<ZaloWebhookInfo>> {
  return callZaloApi<ZaloWebhookInfo>("getWebhookInfo", token, undefined, { fetch: fetcher });
}
