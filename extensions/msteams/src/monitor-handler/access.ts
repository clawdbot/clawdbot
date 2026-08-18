// Msteams plugin module implements access behavior.
import { formatAllowlistMatchMeta } from "openclaw/plugin-sdk/allow-from";
import { logInboundDrop } from "openclaw/plugin-sdk/channel-inbound";
import {
  channelIngressRoutes,
  resolveStableChannelMessageIngress,
  type ChannelIngressContextBinding,
  type StableChannelIngressIdentityParams,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_ACCOUNT_ID,
  createChannelPairingController,
  isDangerousNameMatchingEnabled,
  resolveDefaultGroupPolicy,
  type OpenClawConfig,
} from "../../runtime-api.js";
import type {
  StoredConversationReference,
  MSTeamsConversationStore,
} from "../conversation-store.js";
import { formatUnknownError } from "../errors.js";
import { normalizeMSTeamsConversationId } from "../inbound.js";
import type { MSTeamsMonitorLogger } from "../monitor-types.js";
import { resolveMSTeamsAllowlistMatch, resolveMSTeamsRouteConfig } from "../policy.js";
import { looksLikeMSTeamsConversationId } from "../resolve-allowlist.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";

const MSTEAMS_SENDER_NAME_KIND = "plugin:msteams-sender-name" as const;
const MSTEAMS_CONVERSATION_ID_KIND = "plugin:msteams-conversation-id" as const;
const msteamsIngressIdentity = {
  key: "sender-id",
  normalize: normalizeIngressValue,
  aliases: [
    {
      key: "sender-name",
      kind: MSTEAMS_SENDER_NAME_KIND,
      normalizeEntry: normalizeSenderNameIngressValue,
      normalizeSubject: normalizeSenderNameIngressValue,
      dangerous: true,
    },
    {
      key: "conversation-id",
      kind: MSTEAMS_CONVERSATION_ID_KIND,
      normalizeEntry: normalizeAllowlistConversationId,
      normalizeSubject: normalizeAllowlistConversationId,
    },
  ],
  isWildcardEntry: (entry) => normalizeIngressValue(entry) === "*",
  resolveEntryId: ({ entryIndex, fieldKey }) =>
    `msteams-entry-${entryIndex + 1}:${
      fieldKey === "sender-name"
        ? "name"
        : fieldKey === "conversation-id"
          ? "conversation-id"
          : "id"
    }`,
} satisfies StableChannelIngressIdentityParams;

function normalizeIngressValue(value?: string | null): string | null {
  return normalizeOptionalLowercaseString(value) ?? null;
}

function normalizeSenderNameIngressValue(value?: string | null): string | null {
  const normalized = normalizeIngressValue(value);
  if (!normalized) {
    return null;
  }
  // Conversation allowlist entries must never become spoofable display-name principals.
  return looksLikeMSTeamsConversationId(normalizeMSTeamsConversationId(normalized))
    ? null
    : normalized;
}

function normalizeAllowlistConversationId(value?: string | null): string | null {
  const trimmed = value?.trim();
  // Microsoft Graph conversation IDs are opaque; case-folding would authorize a different chat.
  return trimmed ? normalizeMSTeamsConversationId(trimmed) : null;
}

function formatMSTeamsSenderReason(params: {
  reasonCode: string;
  dmPolicy?: string;
  groupPolicy?: string;
}): string {
  switch (params.reasonCode) {
    case "dm_policy_open":
      return "dmPolicy=open";
    case "dm_policy_disabled":
      return "dmPolicy=disabled";
    case "dm_policy_pairing_required":
      return "dmPolicy=pairing (not allowlisted)";
    case "dm_policy_allowlisted":
      return `dmPolicy=${params.dmPolicy ?? "allowlist"} (allowlisted)`;
    case "dm_policy_not_allowlisted":
      return `dmPolicy=${params.dmPolicy ?? "allowlist"} (not allowlisted)`;
    case "group_policy_disabled":
      return "groupPolicy=disabled";
    case "group_policy_empty_allowlist":
    case "route_sender_empty":
      return "groupPolicy=allowlist (empty allowlist)";
    case "group_policy_not_allowlisted":
      return "groupPolicy=allowlist (not allowlisted)";
    case "group_policy_open":
      return "groupPolicy=open";
    case "group_policy_allowed":
      return `groupPolicy=${params.groupPolicy ?? "allowlist"}`;
    default:
      return params.reasonCode;
  }
}

export async function resolveMSTeamsSenderAccess(params: {
  cfg: OpenClawConfig;
  activity: MSTeamsTurnContext["activity"];
  hasControlCommand?: boolean;
  conversationThreadId?: string;
  contextBinding?: ChannelIngressContextBinding;
}) {
  const activity = params.activity;
  const msteamsCfg = params.cfg.channels?.msteams;
  const conversationId = normalizeMSTeamsConversationId(activity.conversation?.id ?? "unknown");
  const convType = normalizeOptionalLowercaseString(activity.conversation?.conversationType);
  const isDirectMessage = convType === "personal" || (!convType && !activity.conversation?.isGroup);
  const senderId = activity.from?.aadObjectId ?? activity.from?.id ?? "unknown";
  const senderName = activity.from?.name ?? activity.from?.id ?? senderId;

  const core = getMSTeamsRuntime();
  const pairing = createChannelPairingController({
    core,
    channel: "msteams",
    accountId: DEFAULT_ACCOUNT_ID,
  });
  const dmPolicy = msteamsCfg?.dmPolicy ?? "pairing";
  const configuredDmAllowFrom = msteamsCfg?.allowFrom ?? [];
  const groupAllowFrom = msteamsCfg?.groupAllowFrom;
  const defaultGroupPolicy = resolveDefaultGroupPolicy(params.cfg);
  const groupPolicy =
    !isDirectMessage && msteamsCfg
      ? (msteamsCfg.groupPolicy ?? defaultGroupPolicy ?? "allowlist")
      : "disabled";
  const allowNameMatching = isDangerousNameMatchingEnabled(msteamsCfg);
  const channelGate = resolveMSTeamsRouteConfig({
    cfg: msteamsCfg,
    teamId: activity.channelData?.team?.id,
    teamName: activity.channelData?.team?.name,
    conversationId,
    channelName: activity.channelData?.channel?.name,
    allowNameMatching,
  });

  const resolved = await resolveStableChannelMessageIngress({
    channelId: "msteams",
    accountId: pairing.accountId,
    identity: msteamsIngressIdentity,
    cfg: params.cfg,
    readStoreAllowFrom: pairing.readAllowFromStore,
    subject: {
      stableId: senderId,
      aliases: {
        "sender-name": senderName,
        ...(!isDirectMessage ? { "conversation-id": conversationId } : {}),
      },
    },
    conversation: {
      kind: isDirectMessage ? "direct" : convType === "channel" ? "channel" : "group",
      id: conversationId,
      threadId: params.conversationThreadId,
    },
    ...(params.contextBinding ? { contextBinding: params.contextBinding } : {}),
    route: channelIngressRoutes(
      !isDirectMessage &&
        channelGate.allowlistConfigured && {
          id: "msteams:team-channel",
          kind: "nestedAllowlist",
          allowed: channelGate.allowed,
          precedence: 0,
          matchId: "msteams-route",
          ...(channelGate.allowed && groupPolicy === "allowlist"
            ? {
                senderPolicy: "deny-when-empty" as const,
                senderAllowFromSource: "effective-group" as const,
              }
            : {}),
        },
    ),
    dmPolicy,
    groupPolicy,
    policy: {
      groupAllowFromFallbackToAllowFrom: true,
      mutableIdentifierMatching: allowNameMatching ? "enabled" : "disabled",
    },
    allowFrom: configuredDmAllowFrom,
    groupAllowFrom,
    command: {
      allowTextCommands: true,
      hasControlCommand: params.hasControlCommand === true,
      directGroupAllowFrom: isDirectMessage ? "effective" : "none",
    },
  });
  return {
    ...resolved,
    channelIngress: resolved,
    pairing,
    isDirectMessage,
    conversationId,
    senderId,
    senderName,
    msteamsCfg,
    dmPolicy,
    channelGate,
    allowNameMatching,
    groupPolicy,
  };
}

export async function admitMSTeamsMessage(params: {
  cfg: OpenClawConfig;
  activity: MSTeamsTurnContext["activity"];
  text: string;
  conversationId: string;
  conversationRef: StoredConversationReference;
  isChannel: boolean;
  conversationStore: MSTeamsConversationStore;
  log: MSTeamsMonitorLogger;
  logVerboseMessage: (message: string) => void;
}) {
  const core = getMSTeamsRuntime();
  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: params.cfg,
    surface: "msteams",
  });
  const isControlCommand =
    allowTextCommands && core.channel.commands.isControlCommandMessage(params.text, params.cfg);
  const access = await resolveMSTeamsSenderAccess({
    cfg: params.cfg,
    activity: params.activity,
    hasControlCommand: isControlCommand,
  });
  const {
    dmPolicy,
    senderId,
    senderName,
    pairing,
    isDirectMessage,
    channelGate,
    senderAccess,
    commandAccess,
    allowNameMatching,
    groupPolicy,
    msteamsCfg,
  } = access;
  const effectiveDmAllowFrom = senderAccess.effectiveAllowFrom;
  const effectiveGroupAllowFrom = senderAccess.effectiveGroupAllowFrom;

  if (isDirectMessage && msteamsCfg && senderAccess.decision !== "allow") {
    if (senderAccess.reasonCode === "dm_policy_disabled") {
      params.log.info("dropping dm (dms disabled)", {
        sender: senderId,
        label: senderName,
      });
      params.log.debug?.("dropping dm (dms disabled)");
      return null;
    }
    const allowMatch = resolveMSTeamsAllowlistMatch({
      allowFrom: effectiveDmAllowFrom,
      senderId,
      senderName,
      allowNameMatching,
    });
    if (senderAccess.decision === "pairing") {
      params.conversationStore
        .upsert(params.conversationId, params.conversationRef)
        .catch((err: unknown) => {
          params.log.debug?.("failed to save conversation reference", {
            error: formatUnknownError(err),
          });
        });
      const request = await pairing.upsertPairingRequest({
        id: senderId,
        meta: { name: senderName },
      });
      if (request) {
        params.log.info("msteams pairing request created", {
          sender: senderId,
          label: senderName,
        });
      }
    }
    params.log.debug?.("dropping dm (not allowlisted)", {
      sender: senderId,
      label: senderName,
      allowlistMatch: formatAllowlistMatchMeta(allowMatch),
    });
    params.log.info("dropping dm (not allowlisted)", {
      sender: senderId,
      label: senderName,
      dmPolicy,
      reason: formatMSTeamsSenderReason({
        reasonCode: senderAccess.reasonCode,
        dmPolicy,
        groupPolicy,
      }),
      allowlistMatch: formatAllowlistMatchMeta(allowMatch),
    });
    return null;
  }

  if (!isDirectMessage && msteamsCfg) {
    if (channelGate.allowlistConfigured && !channelGate.allowed) {
      params.log.info("dropping group message (not in team/channel allowlist)", {
        conversationId: params.conversationId,
        teamKey: channelGate.teamKey ?? "none",
        channelKey: channelGate.channelKey ?? "none",
        channelMatchKey: channelGate.channelMatchKey ?? "none",
        channelMatchSource: channelGate.channelMatchSource ?? "none",
      });
      params.log.debug?.("dropping group message (not in team/channel allowlist)", {
        conversationId: params.conversationId,
        teamKey: channelGate.teamKey ?? "none",
        channelKey: channelGate.channelKey ?? "none",
        channelMatchKey: channelGate.channelMatchKey ?? "none",
        channelMatchSource: channelGate.channelMatchSource ?? "none",
      });
      return null;
    }

    if (!senderAccess.allowed && senderAccess.reasonCode === "group_policy_disabled") {
      params.log.info("dropping group message (groupPolicy: disabled)", {
        conversationId: params.conversationId,
      });
      params.log.debug?.("dropping group message (groupPolicy: disabled)", {
        conversationId: params.conversationId,
      });
      return null;
    }
    if (
      !senderAccess.allowed &&
      (senderAccess.reasonCode === "group_policy_empty_allowlist" ||
        senderAccess.reasonCode === "route_sender_empty")
    ) {
      params.log.info("dropping group message (groupPolicy: allowlist, no allowlist)", {
        conversationId: params.conversationId,
      });
      params.log.debug?.("dropping group message (groupPolicy: allowlist, no allowlist)", {
        conversationId: params.conversationId,
      });
      return null;
    }
    if (!senderAccess.allowed) {
      const allowMatch = resolveMSTeamsAllowlistMatch({
        allowFrom: effectiveGroupAllowFrom,
        senderId,
        senderName,
        allowNameMatching,
      });
      params.log.debug?.("dropping group message (not in groupAllowFrom)", {
        sender: senderId,
        label: senderName,
        allowlistMatch: formatAllowlistMatchMeta(allowMatch),
      });
      params.log.info("dropping group message (not in groupAllowFrom)", {
        sender: senderId,
        label: senderName,
        allowlistMatch: formatAllowlistMatchMeta(allowMatch),
      });
      return null;
    }
  }

  if (commandAccess.shouldBlockControlCommand) {
    logInboundDrop({
      log: params.logVerboseMessage,
      channel: "msteams",
      reason: "control command (unauthorized)",
      target: senderId,
    });
    return null;
  }

  params.conversationStore
    .upsert(params.conversationId, params.conversationRef)
    .catch((err: unknown) => {
      params.log.debug?.("failed to save conversation reference", {
        error: formatUnknownError(err),
      });
    });

  return {
    ...access,
    allowTextCommands,
    isControlCommand,
    commandAuthorized: commandAccess.requested ? commandAccess.authorized : undefined,
    effectiveDmAllowFrom,
    effectiveGroupAllowFrom,
    isChannel: params.isChannel,
  };
}
