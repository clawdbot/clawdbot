// Source-delivery plans decide whether final output is visible through the
// message tool, direct fallback delivery, both, or neither.
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { normalizeTargetForProvider } from "./target-normalization.js";

/** Owner responsible for making source delivery visible to the user. */
export type SourceVisibleDeliveryOwner =
  | "automatic_source"
  | "message_tool"
  | "message_tool_then_direct_fallback"
  | "direct_fallback"
  | "none";

/** Reason code explaining why source delivery policy took this shape. */
export type SourceDeliveryPlanReason =
  | "config"
  | "room_event"
  | "cron_announce"
  | "cron_webhook"
  | "cron_none"
  | "media_completion"
  | "subagent_completion";

/** Configured or inferred destination source delivery must satisfy. */
export type SourceDeliveryTarget = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

/** Message-tool destination observed during a run. */
export type SourceDeliveryMessageToolTarget = {
  tool?: string;
  provider?: string;
  accountId?: string;
  to?: string;
  threadId?: string;
  threadImplicit?: boolean;
  threadSuppressed?: boolean;
  text?: string;
  mediaUrls?: string[];
};

/** Visible message-tool delivery with target verification state. */
export type SourceDeliveryVisibleDelivery = {
  via: "message_tool";
  target: SourceDeliveryMessageToolTarget;
  verifiedTarget: boolean;
};

/** Resolved source-delivery satisfaction result after a run. */
export type SourceDeliveryOutcome = {
  visibleDeliveries: SourceDeliveryVisibleDelivery[];
  verifiedMessageToolDelivery: boolean;
  satisfiesSourceDelivery: boolean;
  unverifiedMessageToolDelivery: boolean;
};

/** Policy contract that decides message-tool ownership and fallback delivery. */
export type SourceDeliveryPlan = {
  owner: SourceVisibleDeliveryOwner;
  reason: SourceDeliveryPlanReason;
  target: SourceDeliveryTarget;
  normalFinal: "visible" | "private";
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  messageTool: {
    enabled: boolean;
    force: boolean;
    requireExplicitTarget: boolean;
    defaultTarget: boolean;
  };
  fallback: {
    directDelivery: boolean;
    skipWhenMessageToolSentToTarget: boolean;
    bestEffort: boolean;
  };
  progress: {
    allowCallbacksWhenSourceDeliverySuppressed: boolean;
  };
};

function isMessageToolOwnedDelivery(owner: SourceVisibleDeliveryOwner): boolean {
  return owner === "message_tool" || owner === "message_tool_then_direct_fallback";
}

function normalizeDeliveryTarget(channel: string, to: string): string {
  const toTrimmed = to.trim();
  return normalizeTargetForProvider(channel, toTrimmed) ?? toTrimmed;
}

const caseSensitivePrefixedTargetProviders = new Set(["googlechat", "mattermost", "matrix"]);
const lowercaseNormalizedPrefixedTargetProviders = new Set(["discord", "slack"]);

function deliveryTargetsMatch(channel: string, targetTo: string, deliveryTo: string): boolean {
  const targetToTrimmed = targetTo.trim();
  const deliveryToTrimmed = deliveryTo.trim();
  if (targetToTrimmed === deliveryToTrimmed) {
    return true;
  }
  const targetPrefixed = targetToTrimmed.match(/^([a-z][a-z0-9_-]*):(.*)$/i);
  const deliveryPrefixed = deliveryToTrimmed.match(/^([a-z][a-z0-9_-]*):(.*)$/i);
  const targetKind = targetPrefixed?.[1]?.toLowerCase();
  const deliveryKind = deliveryPrefixed?.[1]?.toLowerCase();
  if (
    targetKind &&
    targetKind === deliveryKind &&
    ["channel", "conversation", "group", "user"].includes(targetKind)
  ) {
    // Some provider-owned ids are case-sensitive while Slack/Discord ids are
    // compared case-insensitively; decide that before generic target normalization.
    const targetId = targetPrefixed?.[2]?.trim();
    const deliveryId = deliveryPrefixed?.[2]?.trim();
    if (caseSensitivePrefixedTargetProviders.has(channel)) {
      return targetId === deliveryId;
    }
    if (lowercaseNormalizedPrefixedTargetProviders.has(channel)) {
      return targetId?.toLowerCase() === deliveryId?.toLowerCase();
    }
  }
  return (
    normalizeDeliveryTarget(channel, targetToTrimmed) ===
    normalizeDeliveryTarget(channel, deliveryToTrimmed)
  );
}

function normalizeDeliveryThreadId(threadId: string | number | undefined): string | undefined {
  return stringifyRouteThreadId(threadId)?.trim() || undefined;
}

function extractTopicThreadId(targetTo: string): string | undefined {
  return targetTo.match(/:topic:(\d+)$/i)?.[1];
}

/** Compares a message-tool target with the required source delivery target. */
export function sourceDeliveryTargetsMatch(
  target: SourceDeliveryMessageToolTarget,
  delivery: SourceDeliveryTarget,
): boolean {
  if (!delivery.channel || !delivery.to || !target.to) {
    return false;
  }
  const channel = delivery.channel.trim().toLowerCase();
  const provider = target.provider?.trim().toLowerCase();
  if (provider && provider !== "message" && provider !== channel) {
    return false;
  }
  if (delivery.accountId && target.accountId && target.accountId !== delivery.accountId) {
    return false;
  }
  // Strip :topic:NNN from message targets and normalize Feishu/Lark prefixes on
  // both sides so source-delivery suppression compares canonical IDs.
  if (!deliveryTargetsMatch(channel, target.to.replace(/:topic:\d+$/, ""), delivery.to)) {
    return false;
  }
  const deliveryThreadId = normalizeDeliveryThreadId(delivery.threadId);
  const targetThreadId =
    normalizeDeliveryThreadId(target.threadId) ?? extractTopicThreadId(target.to);
  if (!deliveryThreadId && !targetThreadId) {
    return true;
  }
  if (deliveryThreadId && !targetThreadId) {
    return target.threadImplicit === true && target.threadSuppressed !== true;
  }
  return deliveryThreadId === targetThreadId;
}

/** Builds a source delivery plan from ownership and fallback inputs. */
export function createSourceDeliveryPlan(params: {
  owner: SourceVisibleDeliveryOwner;
  reason: SourceDeliveryPlanReason;
  target?: SourceDeliveryTarget;
  messageToolEnabled?: boolean;
  messageToolForced?: boolean;
  requireExplicitMessageTarget?: boolean;
  directFallback?: boolean;
  skipFallbackWhenMessageToolSentToTarget?: boolean;
  fallbackBestEffort?: boolean;
  allowProgressCallbacksWhenSourceDeliverySuppressed?: boolean;
}): SourceDeliveryPlan {
  const messageToolOwnsDelivery = isMessageToolOwnedDelivery(params.owner);
  const sourceReplyDeliveryMode = messageToolOwnsDelivery ? "message_tool_only" : undefined;
  const directDelivery =
    params.directFallback ??
    (params.owner === "direct_fallback" || params.owner === "message_tool_then_direct_fallback");
  return {
    owner: params.owner,
    reason: params.reason,
    target: params.target ?? {},
    normalFinal:
      sourceReplyDeliveryMode === "message_tool_only" || params.owner === "none"
        ? "private"
        : "visible",
    sourceReplyDeliveryMode,
    messageTool: {
      enabled: params.messageToolEnabled ?? messageToolOwnsDelivery,
      force: params.messageToolForced ?? messageToolOwnsDelivery,
      requireExplicitTarget: params.requireExplicitMessageTarget ?? false,
      defaultTarget: Boolean(params.target?.channel || params.target?.to),
    },
    fallback: {
      directDelivery,
      skipWhenMessageToolSentToTarget:
        params.skipFallbackWhenMessageToolSentToTarget ??
        params.owner === "message_tool_then_direct_fallback",
      bestEffort: params.fallbackBestEffort ?? false,
    },
    progress: {
      allowCallbacksWhenSourceDeliverySuppressed:
        params.allowProgressCallbacksWhenSourceDeliverySuppressed ?? false,
    },
  };
}

function resolveImplicitMessageToolDeliveryTarget(
  plan: SourceDeliveryPlan,
): SourceDeliveryMessageToolTarget | undefined {
  if (!plan.target.channel || !plan.target.to) {
    return undefined;
  }
  const threadId = stringifyRouteThreadId(plan.target.threadId);
  return {
    tool: "message",
    provider: plan.target.channel,
    ...(plan.target.accountId ? { accountId: plan.target.accountId } : {}),
    ...(plan.target.to ? { to: plan.target.to } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

/** Evaluates whether observed message-tool sends satisfy the source delivery plan. */
export function resolveSourceDeliveryOutcome(
  plan: SourceDeliveryPlan,
  params: {
    didSendViaMessageTool?: boolean;
    messageToolSentTargets?: SourceDeliveryMessageToolTarget[];
  },
): SourceDeliveryOutcome {
  const didSendViaMessageTool = params.didSendViaMessageTool === true;
  const explicitTargets = params.messageToolSentTargets ?? [];
  // A send without explicit target metadata still counts when the plan has a default target.
  const sentTargets =
    explicitTargets.length > 0
      ? explicitTargets
      : didSendViaMessageTool
        ? [resolveImplicitMessageToolDeliveryTarget(plan)].filter(
            (target): target is SourceDeliveryMessageToolTarget => Boolean(target),
          )
        : [];
  const visibleDeliveries = sentTargets.map((target) => ({
    via: "message_tool" as const,
    target,
    verifiedTarget: sourceDeliveryTargetsMatch(target, plan.target),
  }));
  const hasVerifiedMessageToolDelivery = visibleDeliveries.some(
    (delivery) => didSendViaMessageTool && delivery.verifiedTarget,
  );
  return {
    visibleDeliveries,
    verifiedMessageToolDelivery: hasVerifiedMessageToolDelivery,
    satisfiesSourceDelivery:
      plan.fallback.skipWhenMessageToolSentToTarget && hasVerifiedMessageToolDelivery,
    unverifiedMessageToolDelivery:
      didSendViaMessageTool && sentTargets.length > 0 && !hasVerifiedMessageToolDelivery,
  };
}
