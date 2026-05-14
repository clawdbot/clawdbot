import crypto from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { getGoogleChatAccessToken } from "./auth.js";
import type { GoogleChatReaction } from "./types.js";

const CHAT_API_BASE = "https://chat.googleapis.com/v1";
const CHAT_UPLOAD_BASE = "https://chat.googleapis.com/upload/v1";

const headersToObject = (headers?: HeadersInit): Record<string, string> =>
  headers instanceof Headers
    ? Object.fromEntries(headers.entries())
    : Array.isArray(headers)
      ? Object.fromEntries(headers)
      : headers || {};

async function withGoogleChatResponse<T>(params: {
  account: ResolvedGoogleChatAccount;
  url: string;
  init?: RequestInit;
  auditContext: string;
  errorPrefix?: string;
  handleResponse: (response: Response) => Promise<T>;
}): Promise<T> {
  const {
    account,
    url,
    init,
    auditContext,
    errorPrefix = "Google Chat API",
    handleResponse,
  } = params;
  const token = await getGoogleChatAccessToken(account);
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      ...init,
      headers: {
        ...headersToObject(init?.headers),
        Authorization: `Bearer ${token}`,
      },
    },
    auditContext,
  });
  try {
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`${errorPrefix} ${response.status}: ${text || response.statusText}`);
    }
    return await handleResponse(response);
  } finally {
    await release();
  }
}

async function fetchJson<T>(
  account: ResolvedGoogleChatAccount,
  url: string,
  init: RequestInit,
): Promise<T> {
  return await withGoogleChatResponse({
    account,
    url,
    init: {
      ...init,
      headers: {
        ...headersToObject(init.headers),
        "Content-Type": "application/json",
      },
    },
    auditContext: "googlechat.api.json",
    handleResponse: async (response) => (await response.json()) as T,
  });
}

async function fetchOk(
  account: ResolvedGoogleChatAccount,
  url: string,
  init: RequestInit,
): Promise<void> {
  await withGoogleChatResponse({
    account,
    url,
    init,
    auditContext: "googlechat.api.ok",
    handleResponse: async () => undefined,
  });
}

async function fetchBuffer(
  account: ResolvedGoogleChatAccount,
  url: string,
  init?: RequestInit,
  options?: { maxBytes?: number },
): Promise<{ buffer: Buffer; contentType?: string }> {
  return await withGoogleChatResponse({
    account,
    url,
    init,
    auditContext: "googlechat.api.buffer",
    handleResponse: async (res) => {
      const maxBytes = options?.maxBytes;
      const lengthHeader = res.headers.get("content-length");
      if (maxBytes && lengthHeader) {
        const length = Number(lengthHeader);
        if (Number.isFinite(length) && length > maxBytes) {
          throw new Error(`Google Chat media exceeds max bytes (${maxBytes})`);
        }
      }
      if (!maxBytes) {
        const buffer = Buffer.from(await res.arrayBuffer());
        const contentType = res.headers.get("content-type") ?? undefined;
        return { buffer, contentType };
      }
      const buffer = await readResponseWithLimit(res, maxBytes, {
        onOverflow: () => new Error(`Google Chat media exceeds max bytes (${maxBytes})`),
      });
      const contentType = res.headers.get("content-type") ?? undefined;
      return { buffer, contentType };
    },
  });
}

export async function sendGoogleChatMessage(params: {
  account: ResolvedGoogleChatAccount;
  space: string;
  text?: string;
  thread?: string;
  attachments?: Array<{ attachmentUploadToken: string; contentName?: string }>;
}): Promise<{ messageName?: string } | null> {
  const { account, space, text, thread, attachments } = params;
  const body: Record<string, unknown> = {};
  if (text) {
    body.text = text;
  }
  if (thread) {
    body.thread = { name: thread };
  }
  if (attachments && attachments.length > 0) {
    body.attachment = attachments.map((item) =>
      Object.assign(
        { attachmentDataRef: { attachmentUploadToken: item.attachmentUploadToken } },
        item.contentName ? { contentName: item.contentName } : {},
      ),
    );
  }
  const urlObj = new URL(`${CHAT_API_BASE}/${space}/messages`);
  if (thread) {
    urlObj.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
  }
  const url = urlObj.toString();
  const result = await fetchJson<{ name?: string }>(account, url, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return result ? { messageName: result.name } : null;
}

export async function updateGoogleChatMessage(params: {
  account: ResolvedGoogleChatAccount;
  messageName: string;
  text: string;
}): Promise<{ messageName?: string }> {
  const { account, messageName, text } = params;
  const url = `${CHAT_API_BASE}/${messageName}?updateMask=text`;
  const result = await fetchJson<{ name?: string }>(account, url, {
    method: "PATCH",
    body: JSON.stringify({ text }),
  });
  return { messageName: result.name };
}

export async function deleteGoogleChatMessage(params: {
  account: ResolvedGoogleChatAccount;
  messageName: string;
}): Promise<void> {
  const { account, messageName } = params;
  const url = `${CHAT_API_BASE}/${messageName}`;
  await fetchOk(account, url, { method: "DELETE" });
}

export async function uploadGoogleChatAttachment(params: {
  account: ResolvedGoogleChatAccount;
  space: string;
  filename: string;
  buffer: Buffer;
  contentType?: string;
}): Promise<{ attachmentUploadToken?: string }> {
  const { account, space, filename, buffer, contentType } = params;
  const boundary = `openclaw-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ filename });
  const header = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`;
  const mediaHeader = `--${boundary}\r\nContent-Type: ${contentType ?? "application/octet-stream"}\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([
    Buffer.from(header, "utf8"),
    Buffer.from(mediaHeader, "utf8"),
    buffer,
    Buffer.from(footer, "utf8"),
  ]);

  const url = `${CHAT_UPLOAD_BASE}/${space}/attachments:upload?uploadType=multipart`;
  const payload = await withGoogleChatResponse<{
    attachmentDataRef?: { attachmentUploadToken?: string };
  }>({
    account,
    url,
    init: {
      method: "POST",
      headers: {
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
    auditContext: "googlechat.upload",
    errorPrefix: "Google Chat upload",
    handleResponse: async (response) =>
      (await response.json()) as {
        attachmentDataRef?: { attachmentUploadToken?: string };
      },
  });
  return {
    attachmentUploadToken: payload.attachmentDataRef?.attachmentUploadToken,
  };
}

export async function downloadGoogleChatMedia(params: {
  account: ResolvedGoogleChatAccount;
  resourceName: string;
  maxBytes?: number;
}): Promise<{ buffer: Buffer; contentType?: string }> {
  const { account, resourceName, maxBytes } = params;
  const url = `${CHAT_API_BASE}/media/${resourceName}?alt=media`;
  return await fetchBuffer(account, url, undefined, { maxBytes });
}

export async function createGoogleChatReaction(params: {
  account: ResolvedGoogleChatAccount;
  messageName: string;
  emoji: string;
}): Promise<GoogleChatReaction> {
  const { account, messageName, emoji } = params;
  const url = `${CHAT_API_BASE}/${messageName}/reactions`;
  return await fetchJson<GoogleChatReaction>(account, url, {
    method: "POST",
    body: JSON.stringify({ emoji: { unicode: emoji } }),
  });
}

export async function listGoogleChatReactions(params: {
  account: ResolvedGoogleChatAccount;
  messageName: string;
  limit?: number;
}): Promise<GoogleChatReaction[]> {
  const { account, messageName, limit } = params;
  const url = new URL(`${CHAT_API_BASE}/${messageName}/reactions`);
  if (limit && limit > 0) {
    url.searchParams.set("pageSize", String(limit));
  }
  const result = await fetchJson<{ reactions?: GoogleChatReaction[] }>(account, url.toString(), {
    method: "GET",
  });
  return result.reactions ?? [];
}

export async function deleteGoogleChatReaction(params: {
  account: ResolvedGoogleChatAccount;
  reactionName: string;
}): Promise<void> {
  const { account, reactionName } = params;
  const url = `${CHAT_API_BASE}/${reactionName}`;
  await fetchOk(account, url, { method: "DELETE" });
}

export async function findGoogleChatDirectMessage(params: {
  account: ResolvedGoogleChatAccount;
  userName: string;
}): Promise<{ name?: string; displayName?: string } | null> {
  const { account, userName } = params;
  const url = new URL(`${CHAT_API_BASE}/spaces:findDirectMessage`);
  url.searchParams.set("name", userName);
  return await fetchJson<{ name?: string; displayName?: string }>(account, url.toString(), {
    method: "GET",
  });
}

export async function probeGoogleChat(account: ResolvedGoogleChatAccount): Promise<{
  ok: boolean;
  status?: number;
  error?: string;
}> {
  try {
    const url = new URL(`${CHAT_API_BASE}/spaces`);
    url.searchParams.set("pageSize", "1");
    await fetchJson<Record<string, unknown>>(account, url.toString(), {
      method: "GET",
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: formatErrorMessage(err),
    };
  }
}
