import {
  channelIngressRoutes,
  resolveStableChannelMessageIngress,
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
import { normalizeMSTeamsConversationId } from "../inbound.js";
import { resolveMSTeamsRouteConfig } from "../policy.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";

const MSTEAMS_SENDER_NAME_KIND = "plugin:msteams-sender-name" as const;
const msteamsIngressIdentity = {
  key: "sender-id",
  normalize: normalizeIngressValue,
  aliases: [
    {
      key: "sender-name",
      kind: MSTEAMS_SENDER_NAME_KIND,
      normalizeEntry: normalizeIngressValue,
      normalizeSubject: normalizeIngressValue,
      dangerous: true,
    },
  ],
  isWildcardEntry: (entry) => normalizeIngressValue(entry) === "*",
  resolveEntryId: ({ entryIndex, fieldKey }) =>
    `msteams-entry-${entryIndex + 1}:${fieldKey === "sender-name" ? "name" : "id"}`,
} satisfies StableChannelIngressIdentityParams;

function normalizeIngressValue(value?: string | null): string | null {
  return normalizeOptionalLowercaseString(value) ?? null;
}

export async function resolveMSTeamsSenderAccess(params: {
  cfg: OpenClawConfig;
  activity: MSTeamsTurnContext["activity"];
  hasControlCommand?: boolean;
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
      aliases: { "sender-name": senderName },
    },
    conversation: {
      kind: isDirectMessage ? "direct" : convType === "channel" ? "channel" : "group",
      id: conversationId,
      parentId: activity.channelData?.team?.id,
    },
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
