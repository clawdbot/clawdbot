// Discord guild-admin actions need a Discord sender identity for permission checks.
import type { ChannelMessageActionName } from "openclaw/plugin-sdk/channel-contract";

const trustedRequesterGuildAdminActions = new Set<ChannelMessageActionName>([
  "emoji-upload",
  "sticker-upload",
  "role-add",
  "role-remove",
  "channel-create",
  "channel-edit",
  "channel-delete",
  "channel-move",
  "category-create",
  "category-edit",
  "category-delete",
  "event-create",
  "timeout",
  "kick",
  "ban",
]);

export function isTrustedRequesterGuildAdminAction(action: ChannelMessageActionName): boolean {
  return trustedRequesterGuildAdminActions.has(action);
}
