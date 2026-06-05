/**
 * Cached built-in chat channel metadata accessors.
 *
 * Provides ordered channel metadata for setup, status, and selection surfaces.
 */
import { buildChatChannelMetaById, type ChatChannelMeta } from "./chat-meta-shared.js";
import { CHAT_CHANNEL_ORDER, type ChatChannelId } from "./ids.js";

let chatChannelMetaCache: Record<ChatChannelId, ChatChannelMeta> | null = null;

function getChatChannelMetaById(): Record<ChatChannelId, ChatChannelMeta> {
  chatChannelMetaCache ??= buildChatChannelMetaById();
  return chatChannelMetaCache;
}

export type { ChatChannelMeta };

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
export function getChatChannelMeta(id: ChatChannelId): ChatChannelMeta {
  return getChatChannelMetaById()[id];
}
