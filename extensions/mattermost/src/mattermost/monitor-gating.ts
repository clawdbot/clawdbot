// Mattermost plugin module implements monitor gating behavior.
import type { ChatType, OpenClawConfig } from "./runtime-api.js";

export function mapMattermostChannelTypeToChatType(channelType?: string | null): ChatType {
  const normalized = channelType?.trim().toUpperCase();
  if (!normalized) {
    return "direct";
  }
  if (normalized === "D") {
    return "direct";
  }
  if (normalized === "G" || normalized === "P") {
    return "group";
  }
  return "channel";
}

export function resolveMattermostTrustedChatKind(params: {
  channelType?: string | null;
  fallback?: ChatType;
}): ChatType {
  const channelType = params.channelType?.trim();
  if (channelType) {
    return mapMattermostChannelTypeToChatType(channelType);
  }
  return params.fallback ?? "direct";
}

type MattermostRequireMentionResolverInput = {
  cfg: OpenClawConfig;
  channel: "mattermost";
  accountId: string;
  groupId: string;
  requireMentionOverride?: boolean;
};

type MattermostMentionGateInput = {
  kind: ChatType;
  cfg: OpenClawConfig;
  accountId: string;
  channelId: string;
  threadRootId?: string;
  requireMentionOverride?: boolean;
  resolveRequireMention: (params: MattermostRequireMentionResolverInput) => boolean;
  wasMentioned: boolean;
  // Bot has already replied in this thread; treat follow-ups as addressed so the
  // user need not re-mention on every turn (parity with Slack thread participation).
  threadAlreadyEngaged?: boolean;
  isControlCommand: boolean;
  commandAuthorized: boolean;
  oncharEnabled: boolean;
  oncharTriggered: boolean;
  canDetectMention: boolean;
};

type MattermostMentionGateDecision = {
  shouldRequireMention: boolean;
  shouldBypassMention: boolean;
  effectiveWasMentioned: boolean;
  dropReason: "onchar-not-triggered" | "missing-mention" | null;
};

export function evaluateMattermostMentionGate(
  params: MattermostMentionGateInput,
): MattermostMentionGateDecision {
  const shouldRequireMention =
    params.kind !== "direct" &&
    params.resolveRequireMention({
      cfg: params.cfg,
      channel: "mattermost",
      accountId: params.accountId,
      groupId: params.channelId,
      requireMentionOverride: params.requireMentionOverride,
    });
  const shouldBypassMention =
    params.isControlCommand &&
    shouldRequireMention &&
    !params.wasMentioned &&
    params.commandAuthorized;
  const effectiveWasMentioned =
    params.wasMentioned ||
    shouldBypassMention ||
    params.oncharTriggered ||
    params.threadAlreadyEngaged === true;
  if (
    params.oncharEnabled &&
    !params.oncharTriggered &&
    !params.wasMentioned &&
    !params.isControlCommand &&
    params.threadAlreadyEngaged !== true
  ) {
    return {
      shouldRequireMention,
      shouldBypassMention,
      effectiveWasMentioned,
      dropReason: "onchar-not-triggered",
    };
  }
  if (
    params.kind !== "direct" &&
    shouldRequireMention &&
    params.canDetectMention &&
    !effectiveWasMentioned
  ) {
    return {
      shouldRequireMention,
      shouldBypassMention,
      effectiveWasMentioned,
      dropReason: "missing-mention",
    };
  }
  return {
    shouldRequireMention,
    shouldBypassMention,
    effectiveWasMentioned,
    dropReason: null,
  };
}
