import type { ZoomCredentials } from "./types.js";
import { getZoomAccessToken } from "./token.js";

export type ZoomApiOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  body?: unknown;
  headers?: Record<string, string>;
};

export type ZoomApiResponse<T> = {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
};

const ZOOM_API_BASE = "https://api.zoom.us/v2";

/**
 * Make an authenticated request to the Zoom API.
 */
export async function zoomApiFetch<T = unknown>(
  creds: ZoomCredentials,
  endpoint: string,
  options: ZoomApiOptions = {},
): Promise<ZoomApiResponse<T>> {
  const accessToken = await getZoomAccessToken(creds);

  const url = endpoint.startsWith("http") ? endpoint : `${ZOOM_API_BASE}${endpoint}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    ...options.headers,
  };

  const fetchOptions: RequestInit = {
    method: options.method ?? "GET",
    headers,
  };

  if (options.body !== undefined) {
    fetchOptions.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, fetchOptions);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      status: response.status,
      error: text || `HTTP ${response.status}`,
    };
  }

  // Handle empty responses (204 No Content, etc.)
  const contentLength = response.headers.get("content-length");
  if (contentLength === "0" || response.status === 204) {
    return { ok: true, status: response.status };
  }

  try {
    const data = (await response.json()) as T;
    return { ok: true, status: response.status, data };
  } catch {
    return { ok: true, status: response.status };
  }
}

export type ZoomSendMessageParams = {
  /** Robot JID (bot's JID) */
  robotJid: string;
  /** Recipient JID (user or channel) */
  toJid: string;
  /** Account ID */
  accountId: string;
  /** Message content */
  content: {
    head?: {
      text?: string;
      sub_head?: { text?: string };
    };
    body?: Array<{
      type: "message" | "attachments" | "section" | "actions";
      text?: string;
      resource_url?: string;
      information?: { title?: { text?: string }; description?: { text?: string } };
    }>;
  };
  /** Optional: whether this is a channel message */
  isChannel?: boolean;
  /** Optional: reply to a specific message */
  replyMainMessageId?: string;
};

export type ZoomSendMessageResponse = {
  message_id: string;
};

/**
 * Send a message via Zoom Team Chat API.
 * https://developers.zoom.us/docs/team-chat-apps/send-a-chat-message/
 */
export async function sendZoomMessage(
  creds: ZoomCredentials,
  params: ZoomSendMessageParams,
): Promise<ZoomApiResponse<ZoomSendMessageResponse>> {
  const body: Record<string, unknown> = {
    robot_jid: params.robotJid,
    to_jid: params.toJid,
    account_id: params.accountId,
    content: params.content,
  };

  // user_jid is required for DMs but not for channels
  if (!params.isChannel) {
    body.user_jid = params.toJid;
  }

  if (params.replyMainMessageId) {
    body.reply_main_message_id = params.replyMainMessageId;
  }

  return zoomApiFetch<ZoomSendMessageResponse>(creds, "/im/chat/messages", {
    method: "POST",
    body,
  });
}

export type ZoomBotInfo = {
  robot_jid: string;
  display_name: string;
};

/**
 * Get bot info to verify credentials.
 */
export async function getZoomBotInfo(
  creds: ZoomCredentials,
): Promise<ZoomApiResponse<ZoomBotInfo>> {
  // There's no direct "get bot info" endpoint, but we can verify by trying to
  // get user info or just validating the token works
  return zoomApiFetch<ZoomBotInfo>(creds, "/users/me");
}
