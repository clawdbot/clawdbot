/**
 * Zalo Bot API client
 * @see https://bot.zaloplatforms.com/docs
 */

const ZALO_API_BASE = "https://bot-api.zaloplatforms.com";

export type ZaloFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type ZaloApiResponse<T = unknown> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
};

export type ZaloBotInfo = {
  id: string;
  name: string;
  avatar?: string;
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

export type ZaloSendMessageParams = {
  chat_id: string;
  text: string;
};

export type ZaloSendPhotoParams = {
  chat_id: string;
  photo: string;
  caption?: string;
};

export type ZaloSendChatActionParams = {
  chat_id: string;
  action: "typing" | "upload_photo";
};

export type ZaloSetWebhookParams = {
  url: string;
  secret_token: string;
};

export type ZaloWebhookInfo = {
  url?: string;
  updated_at?: number;
  has_custom_certificate?: boolean;
};

export type ZaloGetUpdatesParams = {
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

/**
 * Call the Zalo Bot API
 */
export async function callZaloApi<T = unknown>(
  method: string,
  token: string,
  body?: Record<string, unknown>,
  options?: { timeoutMs?: number; fetch?: ZaloFetch },
): Promise<ZaloApiResponse<T>> {
  const url = `${ZALO_API_BASE}/bot${token}/${method}`;
  const controller = new AbortController();
  const timeoutId = options?.timeoutMs
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : undefined;
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

    const data = (await response.json()) as ZaloApiResponse<T>;

    if (!data.ok) {
      throw new ZaloApiError(
        data.description ?? `Zalo API error: ${method}`,
        data.error_code,
        data.description,
      );
    }

    return data;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
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
  return callZaloApi<ZaloMessage>("sendPhoto", token, params, { fetch: fetcher });
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
