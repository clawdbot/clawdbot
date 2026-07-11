// Message-action input normalization infers channel/target context and rewrites
// legacy target fields before dispatch validation.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  ChannelMessageActionName,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { applyTargetToParams } from "./channel-target.js";
import {
  actionHasResourceReference,
  actionHasTarget,
  actionRequiresTarget,
  resolveActionDeliveryTargetAlias,
  type ActionDeliveryTargetAliasSpec,
} from "./message-action-spec.js";

/** Normalizes message-action args before target validation and dispatch. */
export function normalizeMessageActionInput(params: {
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  toolContext?: ChannelThreadingToolContext;
  targetAliasSpec?: ActionDeliveryTargetAliasSpec;
}): Record<string, unknown> {
  const normalizedArgs = { ...params.args };
  const { action, toolContext } = params;
  const explicitChannel = normalizeOptionalString(normalizedArgs.channel) ?? "";
  const inferredChannel =
    explicitChannel || normalizeMessageChannel(toolContext?.currentChannelProvider) || "";

  const explicitTarget = normalizeOptionalString(normalizedArgs.target) ?? "";
  const hasLegacyTargetFields =
    typeof normalizedArgs.to === "string" || typeof normalizedArgs.channelId === "string";
  const hasLegacyTarget =
    (normalizeOptionalString(normalizedArgs.to) ?? "").length > 0 ||
    (normalizeOptionalString(normalizedArgs.channelId) ?? "").length > 0;
  const legacyTarget =
    normalizeOptionalString(normalizedArgs.to) ??
    normalizeOptionalString(normalizedArgs.channelId) ??
    "";
  const deliveryAliasTarget = resolveActionDeliveryTargetAlias(action, normalizedArgs, {
    channel: inferredChannel,
    aliasSpec: params.targetAliasSpec,
  });
  const hasResourceReference = actionHasResourceReference(action, normalizedArgs, {
    channel: inferredChannel,
    aliasSpec: params.targetAliasSpec,
  });

  if (deliveryAliasTarget && explicitTarget && deliveryAliasTarget !== explicitTarget) {
    throw new Error(`Action ${action} received conflicting target and delivery alias values.`);
  }
  if (deliveryAliasTarget && legacyTarget && deliveryAliasTarget !== legacyTarget) {
    throw new Error(`Action ${action} received conflicting target and delivery alias values.`);
  }

  if (explicitTarget && hasLegacyTargetFields) {
    // Canonical `target` wins over old `to`/`channelId` aliases before validation.
    delete normalizedArgs.to;
    delete normalizedArgs.channelId;
  }

  if (!explicitTarget && !hasLegacyTarget && deliveryAliasTarget) {
    normalizedArgs.target = deliveryAliasTarget;
  }

  if (
    !explicitTarget &&
    !hasLegacyTarget &&
    !deliveryAliasTarget &&
    actionRequiresTarget(action) &&
    (hasResourceReference || !actionHasTarget(action, normalizedArgs, { channel: inferredChannel }))
  ) {
    const inferredTarget =
      normalizeOptionalString(toolContext?.currentChannelId) ??
      normalizeOptionalString(toolContext?.currentMessagingTarget);
    if (inferredTarget) {
      normalizedArgs.target = inferredTarget;
    }
  }

  if (!explicitTarget && actionRequiresTarget(action) && hasLegacyTarget) {
    if (legacyTarget) {
      normalizedArgs.target = legacyTarget;
      delete normalizedArgs.to;
      delete normalizedArgs.channelId;
    }
  }

  if (!explicitChannel) {
    if (inferredChannel && isDeliverableMessageChannel(inferredChannel)) {
      normalizedArgs.channel = inferredChannel;
    }
  }

  applyTargetToParams({ action, args: normalizedArgs });
  const hasCanonicalTarget = [
    normalizedArgs.target,
    normalizedArgs.to,
    normalizedArgs.channelId,
  ].some((value) => Boolean(normalizeOptionalString(value)));
  if (
    actionRequiresTarget(action) &&
    (!actionHasTarget(action, normalizedArgs, { channel: inferredChannel }) ||
      (hasResourceReference && !hasCanonicalTarget))
  ) {
    throw new Error(`Action ${action} requires a target.`);
  }

  return normalizedArgs;
}
