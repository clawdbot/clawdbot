import { getBootstrapChannelPlugin } from "../../channels/plugins/bootstrap-registry.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";

export type MessageActionTargetMode = "to" | "channelId" | "none";

export const MESSAGE_ACTION_TARGET_MODE: Record<ChannelMessageActionName, MessageActionTargetMode> =
  {
    send: "to",
    broadcast: "none",
    poll: "to",
    "poll-vote": "to",
    react: "to",
    reactions: "to",
    read: "to",
    edit: "to",
    unsend: "to",
    reply: "to",
    sendWithEffect: "to",
    renameGroup: "to",
    setGroupIcon: "to",
    addParticipant: "to",
    removeParticipant: "to",
    leaveGroup: "to",
    sendAttachment: "to",
    delete: "to",
    pin: "to",
    unpin: "to",
    "list-pins": "to",
    permissions: "to",
    "thread-create": "to",
    "thread-list": "none",
    "thread-reply": "to",
    search: "none",
    sticker: "to",
    "sticker-search": "none",
    "member-info": "none",
    "role-info": "none",
    "emoji-list": "none",
    "emoji-upload": "none",
    "sticker-upload": "none",
    "role-add": "none",
    "role-remove": "none",
    "channel-info": "channelId",
    "channel-list": "none",
    "channel-create": "none",
    "channel-edit": "channelId",
    "channel-delete": "channelId",
    "channel-move": "channelId",
    "category-create": "none",
    "category-edit": "none",
    "category-delete": "none",
    "topic-create": "to",
    "topic-edit": "to",
    "voice-status": "none",
    "event-list": "none",
    "event-create": "none",
    timeout: "none",
    kick: "none",
    ban: "none",
    "set-profile": "none",
    "set-presence": "none",
    "download-file": "none",
    "upload-file": "to",
  };

type ActionTargetAliasSpec = {
  aliases: string[];
};

const ACTION_TARGET_ALIASES: Partial<Record<ChannelMessageActionName, ActionTargetAliasSpec>> = {
  unsend: { aliases: ["messageId"] },
  edit: { aliases: ["messageId"] },
  react: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
  renameGroup: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
  setGroupIcon: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
  addParticipant: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
  removeParticipant: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
  leaveGroup: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
};

function listActionTargetAliasSpecs(
  action: ChannelMessageActionName,
  channel?: string,
): ActionTargetAliasSpec[] {
  const specs: ActionTargetAliasSpec[] = [];
  const coreSpec = ACTION_TARGET_ALIASES[action];
  if (coreSpec) {
    specs.push(coreSpec);
  }
  const normalizedChannel = normalizeOptionalLowercaseString(channel);
  if (!normalizedChannel) {
    return specs;
  }
  const plugin = getBootstrapChannelPlugin(normalizedChannel);
  const channelSpec = plugin?.actions?.messageActionTargetAliases?.[action];
  if (channelSpec) {
    specs.push(channelSpec);
  }
  return specs;
}

export function actionRequiresTarget(action: ChannelMessageActionName): boolean {
  return MESSAGE_ACTION_TARGET_MODE[action] !== "none";
}

export function actionHasTarget(
  action: ChannelMessageActionName,
  params: Record<string, unknown>,
  options?: { channel?: string },
): boolean {
  const to = normalizeOptionalString(params.to) ?? "";
  if (to) {
    return true;
  }
  const channelId = normalizeOptionalString(params.channelId) ?? "";
  if (channelId) {
    return true;
  }
  const specs = listActionTargetAliasSpecs(action, options?.channel);
  if (specs.length === 0) {
    return false;
  }
  return specs.some((spec) =>
    spec.aliases.some((alias) => {
      const value = params[alias];
      if (typeof value === "string") {
        return Boolean(normalizeOptionalString(value));
      }
      if (typeof value === "number") {
        return Number.isFinite(value);
      }
      return false;
    }),
  );
}
