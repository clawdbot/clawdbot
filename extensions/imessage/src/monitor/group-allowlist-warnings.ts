// Group-allowlist visibility helpers. With groupPolicy="allowlist" the inbound
// sender gate drops every group message when no effective group sender
// allowlist exists (groupAllowFrom, or its allowFrom fallback), regardless of
// channels.imessage.groups. A non-empty groupAllowFrom can admit groups despite
// an empty groups map (senderFilterBypass in src/config/group-policy.ts).
// Without these warnings the drop-all case is invisible at default log level
// during iMessage config migration. See
// https://github.com/openclaw/openclaw/issues/78749.

import { createDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";

const PER_CHAT_WARNING_CACHE_MAX_SIZE = 512;
const startupWarned = new Set<string>();
// Retain warn-once state for recently active chats without allowing every chat
// seen over the process lifetime to accumulate indefinitely.
const perChatWarned = createDedupeCache({
  maxSize: PER_CHAT_WARNING_CACHE_MAX_SIZE,
  ttlMs: 0,
});

/**
 * Fires once per `accountId` at monitor startup when `groupPolicy === "allowlist"`
 * and the effective group sender allowlist is empty. The sender gate runs
 * before the group registry, so `channels.imessage.groups` entries cannot admit
 * traffic without a sender allowlist. A non-empty `groupAllowFrom` makes the
 * configuration potentially valid and suppresses this drop-all warning.
 */
export function warnGroupAllowlistMisconfigOnce(params: {
  groupPolicy: string;
  hasGroupAllowFrom: boolean;
  accountId: string;
  log: (message: string) => void;
}): boolean {
  if (params.groupPolicy !== "allowlist") {
    return false;
  }
  // A non-empty effective groupAllowFrom can admit groups without a groups map
  // (senderFilterBypass in src/config/group-policy.ts), so this is not a
  // provable drop-all configuration.
  if (params.hasGroupAllowFrom) {
    return false;
  }
  const key = `imessage:${params.accountId}`;
  if (startupWarned.has(key)) {
    return false;
  }
  startupWarned.add(key);
  params.log(
    `imessage: groupPolicy="allowlist" for account "${params.accountId}" but no group sender allowlist is configured ` +
      `(channels.imessage.groupAllowFrom, or its allowFrom fallback). ` +
      `Every inbound group message will be dropped. ` +
      `Set channels.imessage.groupAllowFrom (sender handles, chat targets like chat_id:<id>, or "*") to admit group senders, ` +
      `and optionally add channels.imessage.groups entries to scope which chats are allowed.`,
  );
  return true;
}

/**
 * Fires once per `accountId:chat_id` when the runtime allowlist gate drops a
 * group message because that chat_id is not in `channels.imessage.groups`.
 * Retains up to 512 recently active account/chat pairs; evicted chats may warn again.
 */
export function warnGroupAllowlistDropPerChatOnce(params: {
  accountId: string;
  chatId: string | number | undefined;
  log: (message: string) => void;
}): boolean {
  const chat = params.chatId == null ? "" : String(params.chatId).trim();
  if (!chat) {
    return false;
  }
  const key = `imessage:${params.accountId}:${chat}`;
  if (perChatWarned.check(key)) {
    return false;
  }
  params.log(
    `imessage: dropping group message from chat_id=${chat} (account "${params.accountId}") — ` +
      `not in channels.imessage.groups allowlist. ` +
      `Add channels.imessage.groups["${chat}"] or channels.imessage.groups["*"] to allow it.`,
  );
  return true;
}

/** Test helper. Keeps warning-cache state deterministic across test files. */
export function resetGroupAllowlistWarningsForTesting(): void {
  startupWarned.clear();
  perChatWarned.clear();
}
