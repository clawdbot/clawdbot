import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import {
  asDateTimestampMs,
  parseStrictInteger,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import type { IMessageActionTransportOptions } from "./actions-rpc.js";
import { normalizeDirectChatIdentifier } from "./chat-context.js";
import { createIMessageRpcClient } from "./client.js";
import type { IMessageTarget } from "./targets.js";

type IMessageConversationReadOrigin = NonNullable<
  ChannelMessageActionContext["conversationReadOrigin"]
>;

type IMessageChatListResponse = { chats?: unknown };
type ChatListCacheEntry = {
  list: ReadonlyArray<Record<string, unknown>>;
  expiresAt: number;
};

// Cache by the complete account transport identity so action bursts reuse one
// chat snapshot without leaking a same-path account across Messages Macs.
const CHAT_LIST_CACHE_TTL_MS = 30 * 1000;
const chatListCache = new Map<string, ChatListCacheEntry>();

function asChatList(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const chats = (value as IMessageChatListResponse).chats;
  return Array.isArray(chats)
    ? chats.filter(
        (chat): chat is Record<string, unknown> =>
          chat != null && typeof chat === "object" && !Array.isArray(chat),
      )
    : [];
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : parseStrictInteger(value);
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function chatListCacheKey(options: IMessageActionTransportOptions): string {
  return `${options.cliPath}\0${options.dbPath ?? ""}\0${options.remoteHost ?? ""}`;
}

function chatListCacheGet(
  options: IMessageActionTransportOptions,
): ReadonlyArray<Record<string, unknown>> | null {
  const key = chatListCacheKey(options);
  const entry = chatListCache.get(key);
  const now = asDateTimestampMs(Date.now());
  if (!entry || now === undefined || entry.expiresAt <= now) {
    chatListCache.delete(key);
    return null;
  }
  return entry.list;
}

function chatListCacheSet(
  options: IMessageActionTransportOptions,
  list: ReadonlyArray<Record<string, unknown>>,
): void {
  const expiresAt = resolveExpiresAtMsFromDurationMs(CHAT_LIST_CACHE_TTL_MS);
  if (expiresAt !== undefined) {
    chatListCache.set(chatListCacheKey(options), { list, expiresAt });
  }
}

function findChatGuid(
  chats: readonly Record<string, unknown>[],
  target: Extract<IMessageTarget, { kind: "chat_id" | "chat_identifier" }>,
): string | null {
  if (target.kind === "chat_id") {
    for (const chat of chats) {
      const id = numberFromUnknown(chat.id);
      const guid = stringFromUnknown(chat.guid);
      if (id === target.chatId && guid) {
        return guid;
      }
    }
    return null;
  }
  const wanted = normalizeDirectChatIdentifier(target.chatIdentifier);
  for (const chat of chats) {
    const identifier = stringFromUnknown(chat.identifier);
    const guid = stringFromUnknown(chat.guid);
    if (
      guid &&
      (identifier === target.chatIdentifier ||
        guid === target.chatIdentifier ||
        (identifier && normalizeDirectChatIdentifier(identifier) === wanted) ||
        normalizeDirectChatIdentifier(guid) === wanted)
    ) {
      return guid;
    }
  }
  return null;
}

export async function resolveIMessageActionChatGuid(params: {
  target: Extract<IMessageTarget, { kind: "chat_id" | "chat_identifier" }>;
  options: IMessageActionTransportOptions;
  conversationReadOrigin: IMessageConversationReadOrigin;
}): Promise<string | null> {
  const cached = chatListCacheGet(params.options);
  if (cached) {
    return findChatGuid(cached, params.target);
  }
  const client = await createIMessageRpcClient(params.options);
  try {
    const result = await client.request<IMessageChatListResponse>(
      "chats.list",
      { limit: 1000 },
      { timeoutMs: params.options.timeoutMs },
    );
    const list = asChatList(result);
    chatListCacheSet(params.options, list);
    return findChatGuid(list, params.target);
  } finally {
    await client.stop();
  }
}
