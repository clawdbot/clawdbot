import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import {
  DEFAULT_ACCOUNT_ID,
  createChannelPairingController,
  evaluateSenderGroupAccessForPolicy,
  isDangerousNameMatchingEnabled,
  readStoreAllowFromForDmPolicy,
  resolveDefaultGroupPolicy,
  resolveDmGroupAccessWithLists,
  resolveEffectiveAllowFromLists,
  resolveSenderScopedGroupPolicy,
  type OpenClawConfig,
} from "../../runtime-api.js";
import { normalizeMSTeamsConversationId } from "../inbound.js";
import { resolveMSTeamsAllowlistMatch, resolveMSTeamsRouteConfig } from "../policy.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";

export async function resolveMSTeamsSenderAccess(params: {
  cfg: OpenClawConfig;
  activity: MSTeamsTurnContext["activity"];
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
  const storedAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: "msteams",
    accountId: pairing.accountId,
    dmPolicy,
    readStore: pairing.readStoreForDmPolicy,
  });
  const configuredDmAllowFrom = msteamsCfg?.allowFrom ?? [];
  const groupAllowFrom = msteamsCfg?.groupAllowFrom;
  const resolvedAllowFromLists = resolveEffectiveAllowFromLists({
    allowFrom: configuredDmAllowFrom,
    groupAllowFrom,
    storeAllowFrom: storedAllowFrom,
    dmPolicy,
  });
  const defaultGroupPolicy = resolveDefaultGroupPolicy(params.cfg);
  const groupPolicy =
    !isDirectMessage && msteamsCfg
      ? (msteamsCfg.groupPolicy ?? defaultGroupPolicy ?? "allowlist")
      : "disabled";
  const effectiveGroupAllowFrom = resolvedAllowFromLists.effectiveGroupAllowFrom;
  const allowNameMatching = isDangerousNameMatchingEnabled(msteamsCfg);
  const channelGate = resolveMSTeamsRouteConfig({
    cfg: msteamsCfg,
    teamId: activity.channelData?.team?.id,
    teamName: activity.channelData?.team?.name,
    conversationId,
    channelName: activity.channelData?.channel?.name,
    allowNameMatching,
  });

  // When a route-level (team/channel) allowlist is configured but the sender allowlist is
  // empty, resolveSenderScopedGroupPolicy would otherwise downgrade the policy to "open",
  // allowing any sender. To close this bypass (GHSA-g7cr-9h7q-4qxq), treat an empty sender
  // allowlist as deny-all whenever the route allowlist is active.
  const senderGroupPolicy =
    channelGate.allowlistConfigured && effectiveGroupAllowFrom.length === 0
      ? groupPolicy
      : resolveSenderScopedGroupPolicy({
          groupPolicy,
          groupAllowFrom: effectiveGroupAllowFrom,
        });
  const access = resolveDmGroupAccessWithLists({
    isGroup: !isDirectMessage,
    dmPolicy,
    groupPolicy: senderGroupPolicy,
    allowFrom: configuredDmAllowFrom,
    groupAllowFrom,
    storeAllowFrom: storedAllowFrom,
    groupAllowFromFallbackToAllowFrom: false,
    isSenderAllowed: (allowFrom) =>
      resolveMSTeamsAllowlistMatch({
        allowFrom,
        senderId,
        senderName,
        allowNameMatching,
      }).allowed,
  });
  const senderGroupAccess = evaluateSenderGroupAccessForPolicy({
    groupPolicy,
    groupAllowFrom: effectiveGroupAllowFrom,
    senderId,
    isSenderAllowed: (_senderId, allowFrom) =>
      resolveMSTeamsAllowlistMatch({
        allowFrom,
        senderId,
        senderName,
        allowNameMatching,
      }).allowed,
  });

  return {
    msteamsCfg,
    pairing,
    isDirectMessage,
    conversationId,
    senderId,
    senderName,
    dmPolicy,
    channelGate,
    access,
    senderGroupAccess,
    configuredDmAllowFrom,
    effectiveDmAllowFrom: access.effectiveAllowFrom,
    effectiveGroupAllowFrom,
    allowNameMatching,
    groupPolicy,
  };
}
