// Telegram plugin module implements Business Connect state persistence.
//
// Telegram business_connection pushes are not replayed on Gateway restart once
// their update_id has been acked, so connection state (rights, enabled flag)
// must be persisted and lazily re-hydrated via getBusinessConnection when the
// cache misses. Chat routing state (which business_connection_id/last unread
// message a private chat currently maps to) is kept in a second small store so
// outbound sends can attach business_connection_id without needing the
// original inbound Message object in scope.
import type { BusinessConnection } from "grammy/types";
import { getOptionalTelegramRuntime } from "./runtime.js";

const BUSINESS_CONNECTION_NAMESPACE = "telegram.business-connections";
const BUSINESS_CHAT_ROUTE_NAMESPACE = "telegram.business-chat-routes";
const BUSINESS_STORE_MAX_ENTRIES = 5_000;

export type StoredBusinessConnection = {
  id: string;
  userId: number;
  userChatId: number;
  isEnabled: boolean;
  canReply: boolean;
  canReadMessages: boolean;
  updatedAt: number;
};

export type StoredBusinessChatRoute = {
  businessConnectionId: string;
  latestUnreadMessageId?: number;
  updatedAt: number;
};

export class BusinessConnectionNotReadyError extends Error {}

// The outbound send path (resolveTelegramOutboundSendContext) probes for a
// business route on every send, including from callers/tests that never
// initialize the Telegram plugin runtime at all (it has no other reason to
// depend on Telegram Business Connect). Missing runtime must mean "no
// business context here", not a hard failure — only inbound handlers that
// genuinely run inside an initialized Telegram bot ever populate these
// stores in practice.
function openBusinessConnectionStore(env?: NodeJS.ProcessEnv) {
  const runtime = getOptionalTelegramRuntime();
  if (!runtime) {
    return undefined;
  }
  return runtime.state.openKeyedStore<StoredBusinessConnection>({
    namespace: BUSINESS_CONNECTION_NAMESPACE,
    maxEntries: BUSINESS_STORE_MAX_ENTRIES,
    ...(env ? { env } : {}),
  });
}

function openBusinessChatRouteStore(env?: NodeJS.ProcessEnv) {
  const runtime = getOptionalTelegramRuntime();
  if (!runtime) {
    return undefined;
  }
  return runtime.state.openKeyedStore<StoredBusinessChatRoute>({
    namespace: BUSINESS_CHAT_ROUTE_NAMESPACE,
    maxEntries: BUSINESS_STORE_MAX_ENTRIES,
    ...(env ? { env } : {}),
  });
}

function toStoredBusinessConnection(conn: BusinessConnection): StoredBusinessConnection {
  return {
    id: conn.id,
    userId: conn.user.id,
    userChatId: conn.user_chat_id,
    isEnabled: conn.is_enabled ?? true,
    canReply: conn.rights?.can_reply ?? false,
    canReadMessages: conn.rights?.can_read_messages ?? false,
    updatedAt: Date.now(),
  };
}

export async function upsertBusinessConnection(
  conn: BusinessConnection,
  env?: NodeJS.ProcessEnv,
): Promise<StoredBusinessConnection> {
  const stored = toStoredBusinessConnection(conn);
  await openBusinessConnectionStore(env)?.register(conn.id, stored);
  return stored;
}

export async function getStoredBusinessConnection(
  businessConnectionId: string,
  env?: NodeJS.ProcessEnv,
): Promise<StoredBusinessConnection | undefined> {
  return await openBusinessConnectionStore(env)?.lookup(businessConnectionId);
}

/**
 * Resolves connection state from the local cache, falling back to a live
 * getBusinessConnection lookup (and caching the result) on a cache miss —
 * e.g. right after a Gateway restart, before a fresh business_connection push
 * has arrived for this connection.
 */
export async function resolveBusinessConnection(params: {
  businessConnectionId: string;
  fetchConnection: () => Promise<BusinessConnection>;
  env?: NodeJS.ProcessEnv;
}): Promise<StoredBusinessConnection | undefined> {
  const cached = await getStoredBusinessConnection(params.businessConnectionId, params.env);
  if (cached) {
    return cached;
  }
  try {
    const fetched = await params.fetchConnection();
    return await upsertBusinessConnection(fetched, params.env);
  } catch {
    return undefined;
  }
}

export async function assertBusinessConnectionCanReply(
  businessConnectionId: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const conn = await getStoredBusinessConnection(businessConnectionId, env);
  if (!conn) {
    throw new BusinessConnectionNotReadyError(
      `telegram business connection ${businessConnectionId} is unknown; cannot send as this business account.`,
    );
  }
  if (!conn.isEnabled) {
    throw new BusinessConnectionNotReadyError(
      `telegram business connection ${businessConnectionId} is disconnected; cannot send as this business account.`,
    );
  }
  if (!conn.canReply) {
    throw new BusinessConnectionNotReadyError(
      `telegram business connection ${businessConnectionId} does not grant can_reply; cannot send as this business account.`,
    );
  }
}

export async function assertBusinessConnectionCanRead(
  businessConnectionId: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const conn = await getStoredBusinessConnection(businessConnectionId, env);
  if (!conn || !conn.isEnabled || !conn.canReadMessages) {
    throw new BusinessConnectionNotReadyError(
      `telegram business connection ${businessConnectionId} does not grant can_read_messages; cannot mark messages read.`,
    );
  }
}

/** Called on every inbound business_message from a real counterpart (not the connection owner's own echo). */
export async function recordBusinessChatMessage(params: {
  chatId: number | string;
  businessConnectionId: string;
  messageId: number;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const store = openBusinessChatRouteStore(params.env);
  if (!store) {
    return;
  }
  const key = String(params.chatId);
  const next: StoredBusinessChatRoute = {
    businessConnectionId: params.businessConnectionId,
    latestUnreadMessageId: params.messageId,
    updatedAt: Date.now(),
  };
  if (store.update) {
    await store.update(key, () => next);
  } else {
    await store.register(key, next);
  }
}

export async function resolveBusinessChatRoute(
  chatId: number | string,
  env?: NodeJS.ProcessEnv,
): Promise<StoredBusinessChatRoute | undefined> {
  return await openBusinessChatRouteStore(env)?.lookup(String(chatId));
}

/** Clears the pending unread marker once a read receipt has been sent; keeps the connection routing. */
export async function clearBusinessChatUnread(
  chatId: number | string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const store = openBusinessChatRouteStore(env);
  if (!store?.update) {
    return;
  }
  const key = String(chatId);
  await store.update(key, (current) =>
    current ? { ...current, latestUnreadMessageId: undefined, updatedAt: Date.now() } : current,
  );
}
