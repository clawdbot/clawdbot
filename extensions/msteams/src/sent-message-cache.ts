// Msteams plugin module implements sent message cache behavior.
import { createHash } from "node:crypto";
import { createPersistentDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { createPluginStateErrorReporter } from "openclaw/plugin-sdk/plugin-state-runtime";
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
    logError: createPluginStateErrorReporter(
      getOptionalMSTeamsRuntime,
      "msteams",
      "sent-message-state",
      "Microsoft Teams persistent sent-message state failed",
    ),
    // Re-prime with the original send time so restored entries keep their TTL window.
    readTimestamp: (record) => record.sentAt,
  },
});

type MSTeamsSentMessageScope = {
  accountId?: string | null;
};

function normalizeSentMessageAccountId(accountId?: string | null): string {
  const trimmed = accountId?.trim();
  return trimmed ? trimmed : "default";
}

function makeKey(
  conversationId: string,
  messageId: string,
  options?: MSTeamsSentMessageScope,
): string {
  const accountId = normalizeSentMessageAccountId(options?.accountId);
  const messageKey = `${conversationId}:${messageId}`;
  if (accountId === "default") {
    return messageKey;
  }
  const digest = createHash("sha256")
    .update(JSON.stringify([accountId, conversationId, messageId]))
    .digest("hex");
  return `account:v1:${digest}`;
}

export function recordMSTeamsSentMessage(
  conversationId: string,
  messageId: string,
  options?: MSTeamsSentMessageScope,
): void {
  if (!conversationId || !messageId) {
    return;
  }
  const sentAt = Date.now();
  void sentMessages.register(
    makeKey(conversationId, messageId, options),
    { sentAt },
    {
      at: sentAt,
    },
  );
}

export async function wasMSTeamsMessageSentWithPersistence(params: {
  conversationId: string;
  messageId: string;
  accountId?: string | null;
}): Promise<boolean> {
  if (!params.conversationId || !params.messageId) {
    return false;
  }
  return await sentMessages.lookup(makeKey(params.conversationId, params.messageId, params));
}
