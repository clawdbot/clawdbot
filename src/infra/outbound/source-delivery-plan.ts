import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { normalizeTargetForProvider } from "./target-normalization.js";

export type SourceVisibleDeliveryOwner =
  | "automatic_source"
  | "message_tool"
  | "message_tool_then_direct_fallback"
  | "direct_fallback"
  | "none";

export type SourceDeliveryPlanReason =
  | "config"
  | "room_event"
  | "cron_announce"
  | "cron_webhook"
  | "cron_none"
  | "media_completion"
  | "subagent_completion";

export type SourceDeliveryTarget = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

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

export type SourceDeliveryVisibleDelivery = {
  via: "message_tool";
  target: SourceDeliveryMessageToolTarget;
  verifiedTarget: boolean;
};

export type SourceDeliveryOutcome = {
  visibleDeliveries: SourceDeliveryVisibleDelivery[];
  verifiedMessageToolDelivery: boolean;
  satisfiesSourceDelivery: boolean;
  unverifiedMessageToolDelivery: boolean;
};

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

function normalizeDeliveryThreadId(threadId: string | number | undefined): string | undefined {
  return stringifyRouteThreadId(threadId)?.trim() || undefined;
}

function extractTopicThreadId(targetTo: string): string | undefined {
  return targetTo.match(/:topic:(\d+)$/i)?.[1];
}

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
  const normalizedTargetTo = normalizeDeliveryTarget(channel, target.to.replace(/:topic:\d+$/, ""));
  const normalizedDeliveryTo = normalizeDeliveryTarget(channel, delivery.to);
  if (normalizedTargetTo !== normalizedDeliveryTo) {
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

export function resolveSourceDeliveryOutcome(
  plan: SourceDeliveryPlan,
  params: {
    didSendViaMessageTool?: boolean;
    messageToolSentTargets?: SourceDeliveryMessageToolTarget[];
  },
): SourceDeliveryOutcome {
  const didSendViaMessageTool = params.didSendViaMessageTool === true;
  const explicitTargets = params.messageToolSentTargets ?? [];
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
