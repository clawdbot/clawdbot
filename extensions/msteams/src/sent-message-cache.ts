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

type MSTeamsSentMessageScope = {
  accountId?: string | null;
};

function normalizeSentMessageAccountId(accountId?: string | null): string {
  const trimmed = accountId?.trim();
  return trimmed ? trimmed : "default";
}

function makeAccountDigest(accountId: string): string {
  return createHash("sha256").update(accountId).digest("hex");
}

const namedAccountCaches = new Map<
  string,
  ReturnType<typeof createPersistentDedupeCache<MSTeamsSentMessageRecord>>
>();

function createSentMessageCache(accountId: string) {
  const isDefault = accountId === "default";
  const accountDigest = isDefault ? undefined : makeAccountDigest(accountId);
  return createPersistentDedupeCache<MSTeamsSentMessageRecord>({
    globalKey: isDefault
      ? MSTEAMS_SENT_MESSAGES_KEY
      : Symbol.for(`openclaw.msteamsSentMessages.account.v1.${accountDigest}`),
    ttlMs: TTL_MS,
    maxSize: MAX_ENTRIES,
    persistent: {
      // Each named account owns its retention budget; keep the shipped default namespace intact.
      namespace: isDefault
        ? PERSISTENT_NAMESPACE
        : `${PERSISTENT_NAMESPACE}.account.v1.${accountDigest}`,
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
}

const defaultSentMessages = createSentMessageCache("default");

function getSentMessageCache(accountId: string) {
  if (accountId === "default") {
    return defaultSentMessages;
  }
  let cache = namedAccountCaches.get(accountId);
  if (!cache) {
    cache = createSentMessageCache(accountId);
    namedAccountCaches.set(accountId, cache);
  }
  return cache;
}

function makeKey(conversationId: string, messageId: string): string {
  return `${conversationId}:${messageId}`;
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
  const accountId = normalizeSentMessageAccountId(options?.accountId);
  void getSentMessageCache(accountId).register(
    makeKey(conversationId, messageId),
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
  const accountId = normalizeSentMessageAccountId(params.accountId);
  return await getSentMessageCache(accountId).lookup(
    makeKey(params.conversationId, params.messageId),
  );
}
