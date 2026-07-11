// Message-action specs describe which actions need destinations and which
// legacy/plugin aliases count as an existing target.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "@openclaw/normalization-core/string-coerce";
import { getBootstrapChannelPlugin } from "../../channels/plugins/bootstrap-registry.js";
import type {
  ChannelMessageActionName,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import { hasPotentialPluginActionParam } from "./message-action-param-keys.js";

/**
 * Canonical parameter shape used by an outbound message action target.
 */
export type MessageActionTargetMode = "to" | "channelId" | "none";

/**
 * Target-parameter policy for each supported channel message action.
 */
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

export type ActionDeliveryTargetAliasSpec = ActionTargetAliasSpec & {
  deliveryTargetAliases?: string[];
  resolveDeliveryTarget?: (params: { args: Record<string, unknown> }) => string | undefined;
  matchesCurrentConversation?: (params: {
    args: Record<string, unknown>;
    accountId: string;
    toolContext: ChannelThreadingToolContext;
  }) => boolean;
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
  params: Record<string, unknown>,
  channel?: string,
): ActionTargetAliasSpec[] {
  const specs: ActionTargetAliasSpec[] = [];
  const coreSpec = ACTION_TARGET_ALIASES[action];
  if (coreSpec) {
    specs.push(coreSpec);
  }
  const normalizedChannel = normalizeOptionalLowercaseString(channel);
  if (!normalizedChannel || !hasPotentialPluginActionParam(params)) {
    return specs;
  }
  // Plugin aliases are only checked after cheap param-shape screening to avoid bootstrap reads.
  const plugin = getBootstrapChannelPlugin(normalizedChannel);
  const channelSpec = plugin?.actions?.messageActionTargetAliases?.[action];
  if (channelSpec) {
    specs.push(channelSpec);
  }
  return specs;
}

/** Resolves a plugin-declared delivery alias into the shared target contract. */
export function resolveActionDeliveryTargetAlias(
  action: ChannelMessageActionName,
  params: Record<string, unknown>,
  options?: { channel?: string; aliasSpec?: ActionDeliveryTargetAliasSpec },
): string | undefined {
  const channel = normalizeOptionalLowercaseString(options?.channel);
  if (!channel || !hasPotentialPluginActionParam(params)) {
    return undefined;
  }
  const aliases =
    options?.aliasSpec ??
    getBootstrapChannelPlugin(channel)?.actions?.messageActionTargetAliases?.[action];
  const resolved = aliases?.resolveDeliveryTarget?.({ args: params });
  if (resolved !== undefined) {
    return normalizeOptionalString(resolved);
  }
  const deliveryAliases = aliases?.deliveryTargetAliases ?? [];
  const targets = deliveryAliases
    .map((alias) => normalizeOptionalStringifiedId(params[alias]))
    .filter((value): value is string => Boolean(value));
  if (new Set(targets).size > 1) {
    throw new Error(`Action ${action} received conflicting delivery target aliases.`);
  }
  return targets[0];
}

/** Reports whether a plugin alias identifies an existing resource rather than a conversation. */
export function actionHasResourceReference(
  action: ChannelMessageActionName,
  params: Record<string, unknown>,
  options?: { channel?: string; aliasSpec?: ActionDeliveryTargetAliasSpec },
): boolean {
  const channel = normalizeOptionalLowercaseString(options?.channel);
  if (!channel || !hasPotentialPluginActionParam(params)) {
    return false;
  }
  const aliases =
    options?.aliasSpec ??
    getBootstrapChannelPlugin(channel)?.actions?.messageActionTargetAliases?.[action];
  // Legacy alias specs do not distinguish conversations from resources.
  // Do not infer ambient authority unless the owner explicitly partitions them.
  if (!aliases?.deliveryTargetAliases) {
    return false;
  }
  const deliveryAliases = new Set(aliases.deliveryTargetAliases);
  return aliases.aliases.some((alias) => {
    if (deliveryAliases.has(alias)) {
      return false;
    }
    const value = params[alias];
    if (typeof value === "string") {
      return Boolean(normalizeOptionalString(value));
    }
    return typeof value === "number" && Number.isFinite(value);
  });
}

/**
 * Reports whether an action normally needs a destination target.
 */
export function actionRequiresTarget(action: ChannelMessageActionName): boolean {
  return MESSAGE_ACTION_TARGET_MODE[action] !== "none";
}

/**
 * Detects whether an action invocation already carries a usable target.
 */
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
  const specs = listActionTargetAliasSpecs(action, params, options?.channel);
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
