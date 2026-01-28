import type { ResolvedRingCentralAccount } from "./accounts.js";
import { getRingCentralPlatform } from "./auth.js";
import { toRingCentralMarkdown } from "./markdown.js";
import type {
  RingCentralChat,
  RingCentralPost,
  RingCentralUser,
  RingCentralAttachment,
  RingCentralAdaptiveCard,
} from "./types.js";

// Team Messaging API endpoints
const TM_API_BASE = "/team-messaging/v1";

export async function sendRingCentralMessage(params: {
  account: ResolvedRingCentralAccount;
  chatId: string;
  text?: string;
  attachments?: Array<{ id: string; type?: string }>;
}): Promise<{ postId?: string } | null> {
  const { account, chatId, text, attachments } = params;
  const platform = await getRingCentralPlatform(account);

  const body: Record<string, unknown> = {};
  if (text) body.text = toRingCentralMarkdown(text);
  if (attachments && attachments.length > 0) {
    body.attachments = attachments;
  }

  const response = await platform.post(`${TM_API_BASE}/chats/${chatId}/posts`, body);
  const result = (await response.json()) as RingCentralPost;
  return result ? { postId: result.id } : null;
}

export async function updateRingCentralMessage(params: {
  account: ResolvedRingCentralAccount;
  chatId: string;
  postId: string;
  text: string;
}): Promise<{ postId?: string }> {
  const { account, chatId, postId, text } = params;
  const platform = await getRingCentralPlatform(account);

  const response = await platform.patch(
    `${TM_API_BASE}/chats/${chatId}/posts/${postId}`,
    { text: toRingCentralMarkdown(text) },
  );
  const result = (await response.json()) as RingCentralPost;
  return { postId: result.id };
}

export async function deleteRingCentralMessage(params: {
  account: ResolvedRingCentralAccount;
  chatId: string;
  postId: string;
}): Promise<void> {
  const { account, chatId, postId } = params;
  const platform = await getRingCentralPlatform(account);
  await platform.delete(`${TM_API_BASE}/chats/${chatId}/posts/${postId}`);
}

export async function getRingCentralChat(params: {
  account: ResolvedRingCentralAccount;
  chatId: string;
}): Promise<RingCentralChat | null> {
  const { account, chatId } = params;
  const platform = await getRingCentralPlatform(account);

  try {
    const response = await platform.get(`${TM_API_BASE}/chats/${chatId}`);
    return (await response.json()) as RingCentralChat;
  } catch {
    return null;
  }
}

export async function listRingCentralChats(params: {
  account: ResolvedRingCentralAccount;
  type?: string[];
  limit?: number;
}): Promise<RingCentralChat[]> {
  const { account, type, limit } = params;
  const platform = await getRingCentralPlatform(account);

  const queryParams: Record<string, string> = {};
  if (type && type.length > 0) queryParams.type = type.join(",");
  if (limit) queryParams.recordCount = String(limit);

  const response = await platform.get(`${TM_API_BASE}/chats`, queryParams);
  const result = (await response.json()) as { records?: RingCentralChat[] };
  return result.records ?? [];
}

export async function getRingCentralUser(params: {
  account: ResolvedRingCentralAccount;
  userId: string;
}): Promise<RingCentralUser | null> {
  const { account, userId } = params;
  const platform = await getRingCentralPlatform(account);

  try {
    const response = await platform.get(`${TM_API_BASE}/persons/${userId}`);
    return (await response.json()) as RingCentralUser;
  } catch {
    return null;
  }
}

export async function getCurrentRingCentralUser(params: {
  account: ResolvedRingCentralAccount;
}): Promise<RingCentralUser | null> {
  const { account } = params;
  const platform = await getRingCentralPlatform(account);

  try {
    const response = await platform.get("/restapi/v1.0/account/~/extension/~");
    return (await response.json()) as RingCentralUser;
  } catch {
    return null;
  }
}

export async function uploadRingCentralAttachment(params: {
  account: ResolvedRingCentralAccount;
  chatId: string;
  filename: string;
  buffer: Buffer;
  contentType?: string;
}): Promise<{ attachmentId?: string }> {
  const { account, chatId, filename, buffer, contentType } = params;
  const platform = await getRingCentralPlatform(account);

  // Create FormData for multipart upload
  const formData = new FormData();
  const blob = new Blob([buffer], { type: contentType || "application/octet-stream" });
  formData.append("file", blob, filename);

  const response = await platform.post(
    `${TM_API_BASE}/chats/${chatId}/files`,
    formData,
  );
  const result = (await response.json()) as RingCentralAttachment;
  return { attachmentId: result.id };
}

export async function downloadRingCentralAttachment(params: {
  account: ResolvedRingCentralAccount;
  contentUri: string;
  maxBytes?: number;
}): Promise<{ buffer: Buffer; contentType?: string }> {
  const { account, contentUri, maxBytes } = params;
  const platform = await getRingCentralPlatform(account);

  const response = await platform.get(contentUri);
  const contentType = response.headers.get("content-type") ?? undefined;
  const arrayBuffer = await response.arrayBuffer();
  
  if (maxBytes && arrayBuffer.byteLength > maxBytes) {
    throw new Error(`RingCentral attachment exceeds max bytes (${maxBytes})`);
  }

  return {
    buffer: Buffer.from(arrayBuffer),
    contentType,
  };
}

// Adaptive Cards API
export async function sendRingCentralAdaptiveCard(params: {
  account: ResolvedRingCentralAccount;
  chatId: string;
  card: RingCentralAdaptiveCard;
  fallbackText?: string;
}): Promise<{ cardId?: string } | null> {
  const { account, chatId, card, fallbackText } = params;
  const platform = await getRingCentralPlatform(account);

  const body = {
    ...card,
    type: "AdaptiveCard",
    $schema: card.$schema ?? "http://adaptivecards.io/schemas/adaptive-card.json",
    version: card.version ?? "1.3",
    ...(fallbackText ? { fallbackText } : {}),
  };

  const response = await platform.post(`${TM_API_BASE}/chats/${chatId}/adaptive-cards`, body);
  const result = (await response.json()) as { id?: string };
  return result ? { cardId: result.id } : null;
}

export async function updateRingCentralAdaptiveCard(params: {
  account: ResolvedRingCentralAccount;
  cardId: string;
  card: RingCentralAdaptiveCard;
  fallbackText?: string;
}): Promise<{ cardId?: string }> {
  const { account, cardId, card, fallbackText } = params;
  const platform = await getRingCentralPlatform(account);

  const body = {
    ...card,
    type: "AdaptiveCard",
    $schema: card.$schema ?? "http://adaptivecards.io/schemas/adaptive-card.json",
    version: card.version ?? "1.3",
    ...(fallbackText ? { fallbackText } : {}),
  };

  const response = await platform.put(`${TM_API_BASE}/adaptive-cards/${cardId}`, body);
  const result = (await response.json()) as { id?: string };
  return { cardId: result.id };
}

export async function deleteRingCentralAdaptiveCard(params: {
  account: ResolvedRingCentralAccount;
  cardId: string;
}): Promise<void> {
  const { account, cardId } = params;
  const platform = await getRingCentralPlatform(account);
  await platform.delete(`${TM_API_BASE}/adaptive-cards/${cardId}`);
}

export async function probeRingCentral(
  account: ResolvedRingCentralAccount,
): Promise<{ ok: boolean; error?: string; elapsedMs: number }> {
  const start = Date.now();
  try {
    const user = await getCurrentRingCentralUser({ account });
    const elapsedMs = Date.now() - start;
    if (user?.id) {
      return { ok: true, elapsedMs };
    }
    return { ok: false, error: "Unable to fetch current user", elapsedMs };
  } catch (err) {
    const elapsedMs = Date.now() - start;
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs,
    };
  }
}
