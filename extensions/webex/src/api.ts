/**
 * Webex REST API wrapper
 *
 * Handles all Webex API calls including:
 * - People API (get self, lookup users)
 * - Messages API (send, get, delete)
 * - Rooms API (list, get)
 * - Webhooks API (manage webhooks)
 */

import { getWebexAuthHeader } from "./auth.js";
import type {
  ResolvedWebexAccount,
  WebexApiError,
  WebexMessage,
  WebexPerson,
  WebexRoom,
  WebexSendMessageParams,
} from "./types.js";

const WEBEX_API_BASE = "https://webexapis.com/v1";

/**
 * Generic fetch helper for Webex API calls
 */
async function fetchWebex<T>(
  account: ResolvedWebexAccount,
  path: string,
  init?: RequestInit,
): Promise<T> {
  if (!account.botToken) {
    throw new Error("Webex bot token not configured");
  }

  const url = `${WEBEX_API_BASE}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: getWebexAuthHeader(account.botToken),
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    let errorInfo: WebexApiError | undefined;
    try {
      errorInfo = JSON.parse(text) as WebexApiError;
    } catch {
      // Not JSON error response
    }
    const message =
      errorInfo?.message ?? errorInfo?.errors?.[0]?.description ?? (text || response.statusText);
    throw new Error(`Webex API ${response.status}: ${message}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

// ============================================================================
// People API
// ============================================================================

/**
 * Get the authenticated bot's own info
 *
 * @returns The bot's person record
 */
export async function getWebexMe(account: ResolvedWebexAccount): Promise<WebexPerson> {
  return fetchWebex<WebexPerson>(account, "/people/me");
}

/**
 * Get a person by ID
 */
export async function getWebexPerson(
  account: ResolvedWebexAccount,
  personId: string,
): Promise<WebexPerson> {
  return fetchWebex<WebexPerson>(account, `/people/${encodeURIComponent(personId)}`);
}

/**
 * List people (search)
 */
export async function listWebexPeople(
  account: ResolvedWebexAccount,
  params?: { email?: string; displayName?: string; max?: number },
): Promise<WebexPerson[]> {
  const query = new URLSearchParams();
  if (params?.email) query.set("email", params.email);
  if (params?.displayName) query.set("displayName", params.displayName);
  if (params?.max) query.set("max", String(params.max));

  const queryStr = query.toString();
  const path = `/people${queryStr ? `?${queryStr}` : ""}`;
  const result = await fetchWebex<{ items: WebexPerson[] }>(account, path);
  return result.items ?? [];
}

// ============================================================================
// Messages API
// ============================================================================

/**
 * Get a message by ID
 *
 * Webex webhooks only send the message ID, not the full message content.
 * This is used to fetch the full message after receiving a webhook event.
 */
export async function getWebexMessage(
  account: ResolvedWebexAccount,
  messageId: string,
): Promise<WebexMessage> {
  return fetchWebex<WebexMessage>(account, `/messages/${encodeURIComponent(messageId)}`);
}

/**
 * Send a message
 *
 * Messages can be sent to:
 * - A room (roomId)
 * - A person by ID (toPersonId)
 * - A person by email (toPersonEmail)
 *
 * @returns The created message
 */
export async function sendWebexMessage(
  account: ResolvedWebexAccount,
  params: WebexSendMessageParams,
): Promise<WebexMessage> {
  const body: Record<string, unknown> = {};

  // Destination (one of these is required)
  if (params.roomId) body.roomId = params.roomId;
  if (params.toPersonId) body.toPersonId = params.toPersonId;
  if (params.toPersonEmail) body.toPersonEmail = params.toPersonEmail;

  // Content
  if (params.text) body.text = params.text;
  if (params.markdown) body.markdown = params.markdown;
  if (params.files && params.files.length > 0) body.files = params.files;
  if (params.parentId) body.parentId = params.parentId;
  if (params.attachments && params.attachments.length > 0) body.attachments = params.attachments;

  return fetchWebex<WebexMessage>(account, "/messages", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Delete a message
 */
export async function deleteWebexMessage(
  account: ResolvedWebexAccount,
  messageId: string,
): Promise<void> {
  await fetchWebex<void>(account, `/messages/${encodeURIComponent(messageId)}`, {
    method: "DELETE",
  });
}

/**
 * List messages in a room
 */
export async function listWebexMessages(
  account: ResolvedWebexAccount,
  roomId: string,
  params?: { max?: number; mentionedPeople?: string; before?: string; beforeMessage?: string },
): Promise<WebexMessage[]> {
  const query = new URLSearchParams();
  query.set("roomId", roomId);
  if (params?.max) query.set("max", String(params.max));
  if (params?.mentionedPeople) query.set("mentionedPeople", params.mentionedPeople);
  if (params?.before) query.set("before", params.before);
  if (params?.beforeMessage) query.set("beforeMessage", params.beforeMessage);

  const result = await fetchWebex<{ items: WebexMessage[] }>(account, `/messages?${query}`);
  return result.items ?? [];
}

// ============================================================================
// Rooms API
// ============================================================================

/**
 * Get a room by ID
 */
export async function getWebexRoom(account: ResolvedWebexAccount, roomId: string): Promise<WebexRoom> {
  return fetchWebex<WebexRoom>(account, `/rooms/${encodeURIComponent(roomId)}`);
}

/**
 * List rooms the bot is a member of
 */
export async function listWebexRooms(
  account: ResolvedWebexAccount,
  params?: { max?: number; type?: "direct" | "group"; sortBy?: "id" | "lastactivity" | "created" },
): Promise<WebexRoom[]> {
  const query = new URLSearchParams();
  if (params?.max) query.set("max", String(params.max));
  if (params?.type) query.set("type", params.type);
  if (params?.sortBy) query.set("sortBy", params.sortBy);

  const queryStr = query.toString();
  const path = `/rooms${queryStr ? `?${queryStr}` : ""}`;
  const result = await fetchWebex<{ items: WebexRoom[] }>(account, path);
  return result.items ?? [];
}

// ============================================================================
// Webhooks API
// ============================================================================

export type WebexWebhook = {
  id: string;
  name: string;
  targetUrl: string;
  resource: "messages" | "memberships" | "rooms" | "attachmentActions";
  event: "created" | "updated" | "deleted" | "all";
  filter?: string;
  secret?: string;
  status: "active" | "inactive";
  created?: string;
  ownedBy?: "org" | "creator";
};

/**
 * List all webhooks
 */
export async function listWebexWebhooks(account: ResolvedWebexAccount): Promise<WebexWebhook[]> {
  const result = await fetchWebex<{ items: WebexWebhook[] }>(account, "/webhooks");
  return result.items ?? [];
}

/**
 * Create a webhook
 */
export async function createWebexWebhook(
  account: ResolvedWebexAccount,
  params: {
    name: string;
    targetUrl: string;
    resource: "messages" | "memberships" | "rooms" | "attachmentActions";
    event: "created" | "updated" | "deleted" | "all";
    filter?: string;
    secret?: string;
  },
): Promise<WebexWebhook> {
  return fetchWebex<WebexWebhook>(account, "/webhooks", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

/**
 * Delete a webhook
 */
export async function deleteWebexWebhook(account: ResolvedWebexAccount, webhookId: string): Promise<void> {
  await fetchWebex<void>(account, `/webhooks/${encodeURIComponent(webhookId)}`, {
    method: "DELETE",
  });
}

/**
 * Update a webhook
 */
export async function updateWebexWebhook(
  account: ResolvedWebexAccount,
  webhookId: string,
  params: {
    name?: string;
    targetUrl?: string;
    secret?: string;
    status?: "active" | "inactive";
  },
): Promise<WebexWebhook> {
  return fetchWebex<WebexWebhook>(account, `/webhooks/${encodeURIComponent(webhookId)}`, {
    method: "PUT",
    body: JSON.stringify(params),
  });
}

// ============================================================================
// File/Attachment Download
// ============================================================================

/**
 * Download a file attachment
 *
 * Webex file URLs require authentication and redirect to the actual content.
 */
export async function downloadWebexFile(
  account: ResolvedWebexAccount,
  fileUrl: string,
  maxBytes?: number,
): Promise<{ buffer: Buffer; contentType?: string; filename?: string }> {
  if (!account.botToken) {
    throw new Error("Webex bot token not configured");
  }

  const response = await fetch(fileUrl, {
    headers: {
      Authorization: getWebexAuthHeader(account.botToken),
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? undefined;
  const contentDisposition = response.headers.get("content-disposition");
  let filename: string | undefined;

  // Parse filename from content-disposition header
  if (contentDisposition) {
    const match = contentDisposition.match(/filename[*]?=(?:UTF-8'')?["']?([^"';\n]+)/i);
    if (match?.[1]) {
      filename = decodeURIComponent(match[1]);
    }
  }

  // Read body with size limit
  const chunks: Buffer[] = [];
  let totalSize = 0;
  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error("No response body");
  }

  const max = maxBytes ?? 100 * 1024 * 1024; // 100MB default limit

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalSize += value.length;
    if (totalSize > max) {
      reader.cancel();
      throw new Error(`File too large (> ${Math.round(max / 1024 / 1024)}MB)`);
    }

    chunks.push(Buffer.from(value));
  }

  return {
    buffer: Buffer.concat(chunks),
    contentType,
    filename,
  };
}

// ============================================================================
// Probe / Health Check
// ============================================================================

/**
 * Probe the Webex API to verify credentials
 */
export async function probeWebex(account: ResolvedWebexAccount): Promise<{
  ok: boolean;
  status?: number;
  error?: string;
  botId?: string;
  botEmail?: string;
  botName?: string;
}> {
  try {
    const me = await getWebexMe(account);
    return {
      ok: true,
      botId: me.id,
      botEmail: me.emails?.[0],
      botName: me.displayName,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const statusMatch = message.match(/Webex API (\d+)/);
    return {
      ok: false,
      status: statusMatch ? parseInt(statusMatch[1], 10) : undefined,
      error: message,
    };
  }
}
