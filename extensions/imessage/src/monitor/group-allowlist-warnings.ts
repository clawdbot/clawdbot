// Group-allowlist visibility helpers. The runtime gate at line ~336 of
// inbound-processing.ts drops every group message when groupPolicy="allowlist"
// and channels.imessage.groups is missing. Without these warnings the drop is
// invisible at default log level — the most common BlueBubbles → bundled-iMessage
// migration footgun. See https://github.com/openclaw/openclaw/issues/78749.

type GroupsConfig = Record<
  string,
  { requireMention?: boolean; tools?: unknown; toolsBySender?: unknown }
>;

const startupWarned = new Set<string>();
const perChatWarned = new Set<string>();

/**
 * Fires once per `accountId` at monitor startup when `groupPolicy === "allowlist"`
 * but `channels.imessage.groups` is empty (no `"*"` wildcard, no explicit
 * `chat_id` entries). Without one of those, every group message is dropped at
 * the second gate even when the sender passes `groupAllowFrom`.
 */
export function warnGroupAllowlistMisconfigOnce(params: {
  groupPolicy: string;
  groups: GroupsConfig | undefined;
  accountId: string;
  log: (message: string) => void;
}): boolean {
  if (params.groupPolicy !== "allowlist") {
    return false;
  }
  const entries = params.groups ? Object.keys(params.groups) : [];
  if (entries.length > 0) {
    return false;
  }
  const key = `imessage:${params.accountId}`;
  if (startupWarned.has(key)) {
    return false;
  }
  startupWarned.add(key);
  params.log(
    `imessage: groupPolicy="allowlist" but channels.imessage.groups is empty for account "${params.accountId}". ` +
      `Every inbound group message will be dropped. ` +
      `Add channels.imessage.groups["*"] = { requireMention: true } to allow all groups, ` +
      `or explicit per-chat_id entries to allow specific groups.`,
  );
  return true;
}

/**
 * Fires once per `accountId:chat_id` when the runtime allowlist gate drops a
 * group message because that chat_id is not in `channels.imessage.groups`.
 * Bounded by the number of distinct group chats the gateway sees.
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
  if (perChatWarned.has(key)) {
    return false;
  }
  perChatWarned.add(key);
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
