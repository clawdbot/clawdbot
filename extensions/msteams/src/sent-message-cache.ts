// Msteams plugin module implements sent message cache behavior.
import { createPersistentDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { getOptionalMSTeamsRuntime } from "./runtime.js";

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 20_000;
const PERSISTENT_MAX_ENTRIES = 1000;
const PERSISTENT_NAMESPACE = "msteams.sent-messages";
const MSTEAMS_SENT_MESSAGES_KEY = Symbol.for("openclaw.msteamsSentMessages");

type MSTeamsSentMessageRecord = {
  sentAt: number;
};

const sentMessages = createPersistentDedupeCache<MSTeamsSentMessageRecord>({
  globalKey: MSTEAMS_SENT_MESSAGES_KEY,
  ttlMs: TTL_MS,
  maxSize: MAX_ENTRIES,
  persistent: {
    namespace: PERSISTENT_NAMESPACE,
    maxEntries: PERSISTENT_MAX_ENTRIES,
    openStore: (options) => getOptionalMSTeamsRuntime()?.state.openKeyedStore(options),
    logError: (error) => {
      try {
        getOptionalMSTeamsRuntime()
          ?.logging.getChildLogger({ plugin: "msteams", feature: "sent-message-state" })
          .warn("Microsoft Teams persistent sent-message state failed", { error: String(error) });
      } catch {
        // Best effort only: persistent state must never break Teams routing.
      }
    },
    // Re-prime with the original send time so restored entries keep their TTL window.
    readTimestamp: (record) => record.sentAt,
  },
});

function makeKey(conversationId: string, messageId: string): string {
  return `${conversationId}:${messageId}`;
}

export function recordMSTeamsSentMessage(conversationId: string, messageId: string): void {
  if (!conversationId || !messageId) {
    return;
  }
  const sentAt = Date.now();
  void sentMessages.register(makeKey(conversationId, messageId), { sentAt }, { at: sentAt });
}

export async function wasMSTeamsMessageSentWithPersistence(params: {
  conversationId: string;
  messageId: string;
}): Promise<boolean> {
  if (!params.conversationId || !params.messageId) {
    return false;
  }
  return await sentMessages.lookup(makeKey(params.conversationId, params.messageId));
}
