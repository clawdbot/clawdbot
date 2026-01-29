/**
 * Conversation store for Zoom Team Chat proactive messaging.
 *
 * Stores conversation references keyed by channel/user JID so we can
 * send proactive messages later.
 */

/** Stored conversation reference for proactive messaging */
export type StoredConversationReference = {
  /** User JID (sender) */
  userJid?: string;
  /** User display name */
  userName?: string;
  /** User email */
  userEmail?: string;
  /** Channel JID (for channel messages) */
  channelJid?: string;
  /** Channel name */
  channelName?: string;
  /** Account ID */
  accountId?: string;
  /** Robot JID (bot's JID) */
  robotJid?: string;
  /** Conversation type: "direct" or "channel" */
  conversationType?: "direct" | "channel";
  /** Last message ID */
  lastMessageId?: string;
};

export type ZoomConversationStoreEntry = {
  conversationId: string;
  reference: StoredConversationReference;
};

export type ZoomConversationStore = {
  upsert: (conversationId: string, reference: StoredConversationReference) => Promise<void>;
  get: (conversationId: string) => Promise<StoredConversationReference | null>;
  list: () => Promise<ZoomConversationStoreEntry[]>;
  remove: (conversationId: string) => Promise<boolean>;
  findByUserJid: (jid: string) => Promise<ZoomConversationStoreEntry | null>;
};
