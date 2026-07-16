// Imessage plugin module binds provider message ids to one authorized chat.
import { createActionGate } from "openclaw/plugin-sdk/channel-actions";
import type { ResolvedIMessageAccount } from "./accounts.js";
import { chatContextFromIMessageTarget } from "./chat-context.js";
import {
  checkIMessageResourceBinding,
  normalizeIMessageMessageGuidForLookup,
} from "./message-resource-db.js";
import {
  resolveIMessageCachedResourceBinding,
  resolveIMessageMessageId,
  type IMessageChatContext,
} from "./monitor-reply-cache.js";
import type { IMessageService, IMessageTarget } from "./targets.js";

const MAX_REPLY_TO_ID_LENGTH = 256;

type IMessageResourceAuthorizationParams = {
  accountId: string;
  chatContext: IMessageChatContext;
  cliPath: string;
  dbPath?: string;
  hasExclusiveLocalDatabase: boolean;
  remoteHost?: string;
  messageId: string;
  conversationReadOrigin?: string;
};

function sanitizeReplyToId(rawReplyToId?: string): string | undefined {
  const trimmed = rawReplyToId?.trim();
  if (!trimmed) {
    return undefined;
  }
  let sanitized = "";
  for (const ch of trimmed) {
    const code = ch.charCodeAt(0);
    if ((code >= 0 && code <= 31) || code === 127 || ch === "[" || ch === "]") {
      continue;
    }
    sanitized += ch;
  }
  return sanitized.trim().slice(0, MAX_REPLY_TO_ID_LENGTH) || undefined;
}

export function resolveAuthorizedIMessageReplyReference(params: {
  account: ResolvedIMessageAccount;
  target: IMessageTarget;
  cliPath: string;
  dbPath?: string;
  hasExclusiveLocalDatabase: boolean;
  service?: IMessageService;
  replyToId?: string;
  conversationReadOrigin?: string;
}): string | undefined {
  if (!createActionGate(params.account.config.actions)("reply")) {
    return undefined;
  }
  const rawReplyToId = sanitizeReplyToId(params.replyToId);
  if (!rawReplyToId) {
    return undefined;
  }
  const chatContext = chatContextFromIMessageTarget(params.target, params.service);
  const messageId = resolveIMessageMessageId(rawReplyToId, {
    requireKnownShortId: true,
    chatContext,
  });
  authorizeIMessageResourceReference({
    accountId: params.account.accountId,
    chatContext,
    cliPath: params.cliPath,
    dbPath: params.dbPath,
    hasExclusiveLocalDatabase: params.hasExclusiveLocalDatabase,
    remoteHost: params.account.config.remoteHost,
    messageId,
    conversationReadOrigin: params.conversationReadOrigin,
  });
  return messageId;
}

export function authorizeIMessageResourceReference(
  params: IMessageResourceAuthorizationParams,
): void {
  const cacheContext = {
    ...params.chatContext,
    accountId: params.accountId,
  };
  let cacheBinding = resolveIMessageCachedResourceBinding(params.messageId, cacheContext);
  const normalizedMessageId = normalizeIMessageMessageGuidForLookup(params.messageId);
  if (cacheBinding === "unknown" && normalizedMessageId !== params.messageId.trim()) {
    cacheBinding = resolveIMessageCachedResourceBinding(normalizedMessageId, cacheContext);
  }
  if (cacheBinding === "match") {
    return;
  }
  if (cacheBinding === "mismatch") {
    throw new Error("iMessage message reference belongs to a different account or conversation.");
  }

  const providerBinding = params.hasExclusiveLocalDatabase
    ? checkIMessageResourceBinding(params)
    : "unavailable";
  if (providerBinding === "match") {
    return;
  }
  if (providerBinding === "mismatch") {
    throw new Error("iMessage message reference does not belong to the selected conversation.");
  }
  if (params.conversationReadOrigin === "direct-operator") {
    return;
  }
  throw new Error(
    "Delegated iMessage message references require a current same-account conversation binding when the Messages database is unavailable.",
  );
}
