import crypto from "node:crypto";

import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { getGoogleChatAccessToken } from "./auth.js";
import type { GoogleChatReaction } from "./types.js";

const CHAT_API_BASE = "https://chat.googleapis.com/v1";
const CHAT_UPLOAD_BASE = "https://chat.googleapis.com/upload/v1";

async function fetchJson<T>(
  account: ResolvedGoogleChatAccount,
  url: string,
  init: RequestInit,
): Promise<T> {
  const token = await getGoogleChatAccessToken(account);
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google Chat API ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

async function fetchOk(
  account: ResolvedGoogleChatAccount,
  url: string,
  init: RequestInit,
): Promise<void> {
  const token = await getGoogleChatAccessToken(account);
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google Chat API ${res.status}: ${text || res.statusText}`);
  }
}

async function fetchBuffer(
  account: ResolvedGoogleChatAccount,
  url: string,
  init?: RequestInit,
  options?: { maxBytes?: number },
): Promise<{ buffer: Buffer; contentType?: string }> {
  const token = await getGoogleChatAccessToken(account);
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google Chat API ${res.status}: ${text || res.statusText}`);
  }
  const maxBytes = options?.maxBytes;
  const lengthHeader = res.headers.get("content-length");
  if (maxBytes && lengthHeader) {
    const length = Number(lengthHeader);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new Error(`Google Chat media exceeds max bytes (${maxBytes})`);
    }
  }
  if (!maxBytes || !res.body) {
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? undefined;
    return { buffer, contentType };
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Google Chat media exceeds max bytes (${maxBytes})`);
    }
    chunks.push(Buffer.from(value));
  }
  const buffer = Buffer.concat(chunks, total);
  const contentType = res.headers.get("content-type") ?? undefined;
  return { buffer, contentType };
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
  if (text) body.text = text;
  if (thread) body.thread = { name: thread };
  if (attachments && attachments.length > 0) {
    body.attachment = attachments.map((item) => ({
      attachmentDataRef: { attachmentUploadToken: item.attachmentUploadToken },
      ...(item.contentName ? { contentName: item.contentName } : {}),
    }));
  }
  const url = `${CHAT_API_BASE}/${space}/messages`;
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
  const boundary = `moltbot-${crypto.randomUUID()}`;
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

  const token = await getGoogleChatAccessToken(account);
  const url = `${CHAT_UPLOAD_BASE}/${space}/attachments:upload?uploadType=multipart`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google Chat upload ${res.status}: ${text || res.statusText}`);
  }
  const payload = (await res.json()) as {
    attachmentDataRef?: { attachmentUploadToken?: string };
  };
  return { attachmentUploadToken: payload.attachmentDataRef?.attachmentUploadToken };
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
  if (limit && limit > 0) url.searchParams.set("pageSize", String(limit));
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
    await fetchJson<Record<string, unknown>>(account, url.toString(), { method: "GET" });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
