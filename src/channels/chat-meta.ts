/**
 * Cached built-in chat channel metadata accessors.
 *
 * Provides ordered channel metadata for setup, status, and selection surfaces.
 */
import { expectDefined } from "@openclaw/normalization-core";
import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import { buildChatChannelMetaById, type ChatChannelMeta } from "./chat-meta-shared.js";
import { CHAT_CHANNEL_ORDER, type ChatChannelId } from "./ids.js";

let chatChannelMetaCache:
  | { cacheKey: string; metaById: Record<ChatChannelId, ChatChannelMeta> }
  | undefined;

function getChatChannelMetaById(): Record<ChatChannelId, ChatChannelMeta> {
  const cacheKey = resolveBundledPluginsDir(process.env) ?? "";
  if (chatChannelMetaCache?.cacheKey !== cacheKey) {
    chatChannelMetaCache = { cacheKey, metaById: buildChatChannelMetaById() };
  }
  return chatChannelMetaCache.metaById;
}

/**
 * Lists built-in chat channel metadata in configured display order.
 */
export function listChatChannels(): ChatChannelMeta[] {
  const metaById = getChatChannelMetaById();
  return CHAT_CHANNEL_ORDER.map((id) => metaById[id]).filter((meta): meta is ChatChannelMeta =>
    Boolean(meta),
  );
}

/**
 * Returns metadata for one built-in chat channel id.
 */
/** Drift-tolerant lookup: undefined when the id is missing from the bundled catalog. */
export function findChatChannelMeta(id: ChatChannelId): ChatChannelMeta | undefined {
  return getChatChannelMetaById()[id];
}

/**
 * Returns metadata for one built-in chat channel id.
 * Shipped plugin-SDK contract: callers pass bundled ids, so absence is an invariant
 * violation; drift-tolerant core paths use findChatChannelMeta instead.
 */
export function getChatChannelMeta(id: ChatChannelId): ChatChannelMeta {
  return expectDefined(findChatChannelMeta(id), `chat channel meta for ${id}`);
}
