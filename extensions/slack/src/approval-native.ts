import {
  createApproverRestrictedNativeApprovalCapability,
  splitChannelApprovalCapability,
} from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createChannelNativeOriginTargetResolver,
  resolveApprovalRequestSessionConversation,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import {
  channelRouteTargetsMatchExact,
  stringifyRouteThreadId,
} from "openclaw/plugin-sdk/channel-route";
import { normalizeMessageChannel } from "openclaw/plugin-sdk/routing";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { listSlackAccountIds } from "./accounts.js";
import { getSlackApprovalApprovers, isSlackApprovalAuthorizedSender } from "./approval-auth.js";
import {
  isSlackAnyNativeApprovalClientEnabled,
  resolveSlackApprovalKind,
  shouldHandleSlackNativeApprovalRequest,
  type SlackApprovalKind,
  type SlackNativeApprovalRequest,
} from "./approval-native-gates.js";
import {
  getSlackExecApprovalApprovers,
  isSlackExecApprovalAuthorizedSender,
  isSlackExecApprovalClientEnabled,
  resolveSlackExecApprovalTarget,
} from "./exec-approvals.js";
import { parseSlackTarget } from "./targets.js";

type ApprovalRequest = SlackNativeApprovalRequest;
type ApprovalKind = SlackApprovalKind;
type SlackOriginTarget = { to: string; threadId?: string };
type SlackSuppressionAccountInput = {
  target: { channel: string; accountId?: string | null };
  request: {
    request: {
      turnSourceChannel?: string | null;
      turnSourceAccountId?: string | null;
    };
  };
};
type SlackForwardingSuppressionInput = Parameters<
  NonNullable<
    NonNullable<ChannelApprovalCapability["delivery"]>["shouldSuppressForwardingFallback"]
  >
>[0];

const SLACK_DM_CHANNEL_ID_RE = /^D[A-Z0-9]{8,}$/i;
const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{8,}$/i;

function extractSlackSessionKind(
  sessionKey?: string | null,
): "direct" | "channel" | "group" | null {
  if (!sessionKey) {
    return null;
  }
  const match = sessionKey.match(/slack:(direct|channel|group):/i);
  const kind = normalizeLowercaseStringOrEmpty(match?.[1]);
  return kind ? (kind as "direct" | "channel" | "group") : null;
}

function normalizeComparableTarget(value: string): string {
  return normalizeLowercaseStringOrEmpty(value);
}

function normalizeSlackThreadMatchKey(threadId?: string): string {
  return threadId?.trim() ?? "";
}

function resolveSlackTurnSourceDefaultKind(params: {
  turnSourceTo: string;
  sessionKind: "direct" | "channel" | "group" | null;
}): "user" | "channel" {
  // Slack app conversations arrive at Codex as the concrete D-channel plus the
  // app thread root. That live channel target must not be reinterpreted as a
  // user id just because the backing session is direct-message shaped.
  if (SLACK_DM_CHANNEL_ID_RE.test(params.turnSourceTo)) {
    return "channel";
  }
  return params.sessionKind === "direct" ? "user" : "channel";
}

function resolveTurnSourceSlackOriginTarget(request: ApprovalRequest): SlackOriginTarget | null {
  const turnSourceChannel = normalizeLowercaseStringOrEmpty(request.request.turnSourceChannel);
  const turnSourceTo = normalizeOptionalString(request.request.turnSourceTo) ?? "";
  if (turnSourceChannel !== "slack" || !turnSourceTo) {
    return null;
  }
  const sessionKind = extractSlackSessionKind(request.request.sessionKey ?? undefined);
  const parsed = parseSlackTarget(turnSourceTo, {
    defaultKind: resolveSlackTurnSourceDefaultKind({ turnSourceTo, sessionKind }),
  });
  if (!parsed) {
    return null;
  }
  const threadId = stringifyRouteThreadId(request.request.turnSourceThreadId);
  return {
    to: `${parsed.kind}:${parsed.id}`,
    threadId,
  };
}

function resolveSessionSlackOriginTarget(sessionTarget: {
  to: string;
  threadId?: string | number | null;
}): SlackOriginTarget {
  return {
    to: sessionTarget.to,
    threadId: stringifyRouteThreadId(sessionTarget.threadId),
  };
}

function resolveSlackFallbackOriginTarget(request: ApprovalRequest): SlackOriginTarget | null {
  const sessionTarget = resolveApprovalRequestSessionConversation({
    request,
    channel: "slack",
    bundledFallback: false,
  });
  if (!sessionTarget) {
    return null;
  }
  const parsed = parseSlackTarget(sessionTarget.id.toUpperCase(), {
    defaultKind: "channel",
  });
  if (!parsed) {
    return null;
  }
  return {
    to: `${parsed.kind}:${parsed.id}`,
    threadId: sessionTarget.threadId,
  };
}

function normalizeSlackOriginTarget(target: SlackOriginTarget): SlackOriginTarget {
  return {
    ...target,
    to: normalizeComparableTarget(target.to),
  };
}

function parseComparableSlackTarget(target: SlackOriginTarget) {
  return parseSlackTarget(target.to, { defaultKind: "channel" });
}

function isSlackDmChannelToUserRoutePair(a: SlackOriginTarget, b: SlackOriginTarget): boolean {
  const left = parseComparableSlackTarget(a);
  const right = parseComparableSlackTarget(b);
  if (!left || !right) {
    return false;
  }
  return (
    (left.kind === "channel" && SLACK_DM_CHANNEL_ID_RE.test(left.id) && right.kind === "user") ||
    (right.kind === "channel" && SLACK_DM_CHANNEL_ID_RE.test(right.id) && left.kind === "user")
  );
}

function slackTargetsMatch(a: SlackOriginTarget, b: SlackOriginTarget): boolean {
  const threadKey = normalizeSlackThreadMatchKey(a.threadId);
  if (threadKey !== normalizeSlackThreadMatchKey(b.threadId)) {
    return false;
  }
  if (
    channelRouteTargetsMatchExact({
      left: {
        channel: "slack",
        to: a.to,
      },
      right: {
        channel: "slack",
        to: b.to,
      },
    })
  ) {
    return true;
  }
  return Boolean(threadKey && isSlackDmChannelToUserRoutePair(a, b));
}

function resolveSlackNativeSuppressionAccountId({
  target,
  request,
}: SlackSuppressionAccountInput): string | undefined {
  return (
    normalizeOptionalString(target.accountId) ??
    normalizeOptionalString(request.request.turnSourceAccountId)
  );
}

function shouldConsiderSlackNativeForwardingSuppression(
  input: SlackSuppressionAccountInput & { approvalKind: ApprovalKind },
): boolean {
  const channel = normalizeMessageChannel(input.target.channel) ?? input.target.channel;
  if (channel !== "slack") {
    return false;
  }
  if (input.approvalKind === "plugin") {
    return true;
  }
  const turnSourceChannel = normalizeMessageChannel(input.request.request.turnSourceChannel);
  return turnSourceChannel === "slack";
}

function resolveForwardingFallbackSlackTarget(
  target: SlackForwardingSuppressionInput["target"],
): SlackOriginTarget | null {
  const to = normalizeOptionalString(target.to);
  if (!to) {
    return null;
  }
  const parsed = parseSlackTarget(to, {
    defaultKind: SLACK_USER_ID_RE.test(to) ? "user" : "channel",
  });
  if (!parsed) {
    return null;
  }
  return {
    to: `${parsed.kind}:${parsed.id}`,
    threadId: stringifyRouteThreadId(target.threadId),
  };
}

function isSlackPluginForwardingFallbackHandledNatively(
  input: SlackForwardingSuppressionInput,
): boolean {
  const forwardingTarget = resolveForwardingFallbackSlackTarget(input.target);
  if (!forwardingTarget) {
    return false;
  }
  const request = input.request;
  const originTarget = resolveSlackOriginTarget({
    cfg: input.cfg,
    accountId: resolveSlackNativeSuppressionAccountId(input),
    approvalKind: input.approvalKind,
    request,
  });
  if (originTarget && slackTargetsMatch(forwardingTarget, originTarget)) {
    return true;
  }
  return resolveSlackApproverDmTargets({
    cfg: input.cfg,
    accountId: resolveSlackNativeSuppressionAccountId(input),
    approvalKind: input.approvalKind,
    request,
  }).some((target) => slackTargetsMatch(forwardingTarget, target));
}

const resolveSlackOriginTarget = createChannelNativeOriginTargetResolver({
  channel: "slack",
  shouldHandleRequest: ({ cfg, accountId, request }) =>
    shouldHandleSlackNativeApprovalRequest({
      cfg,
      accountId,
      request,
    }),
  resolveTurnSourceTarget: resolveTurnSourceSlackOriginTarget,
  resolveSessionTarget: resolveSessionSlackOriginTarget,
  normalizeTargetForMatch: normalizeSlackOriginTarget,
  targetsMatch: slackTargetsMatch,
  resolveFallbackTarget: resolveSlackFallbackOriginTarget,
});

function resolveSlackApproverDmTargets(params: {
  cfg: Parameters<typeof shouldHandleSlackNativeApprovalRequest>[0]["cfg"];
  accountId?: string | null;
  approvalKind: ApprovalKind;
  request: ApprovalRequest;
}): SlackOriginTarget[] {
  if (
    !shouldHandleSlackNativeApprovalRequest({
      cfg: params.cfg,
      accountId: params.accountId,
      approvalKind: params.approvalKind,
      request: params.request,
    })
  ) {
    return [];
  }
  const approvers =
    params.approvalKind === "plugin"
      ? getSlackApprovalApprovers(params)
      : getSlackExecApprovalApprovers(params);
  return approvers.map((approver) => ({ to: `user:${approver}` }));
}

const baseSlackApprovalCapability = createApproverRestrictedNativeApprovalCapability({
  channel: "slack",
  channelLabel: "Slack",
  describeExecApprovalSetup: ({
    accountId,
  }: Parameters<NonNullable<ChannelApprovalCapability["describeExecApprovalSetup"]>>[0]) => {
    const prefix =
      accountId && accountId !== "default"
        ? `channels.slack.accounts.${accountId}`
        : "channels.slack";
    return `Approve it from the Web UI or terminal UI for now. Slack supports native exec approvals for this account. Configure \`${prefix}.execApprovals.approvers\` or \`commands.ownerAllowFrom\`; leave \`${prefix}.execApprovals.enabled\` unset/\`auto\` or set it to \`true\`.`;
  },
  listAccountIds: listSlackAccountIds,
  hasApprovers: ({ cfg, accountId }) =>
    getSlackExecApprovalApprovers({ cfg, accountId }).length > 0,
  isExecAuthorizedSender: ({ cfg, accountId, senderId }) =>
    isSlackExecApprovalAuthorizedSender({ cfg, accountId, senderId }),
  isPluginAuthorizedSender: ({ cfg, accountId, senderId }) =>
    isSlackApprovalAuthorizedSender({ cfg, accountId, senderId }),
  isNativeDeliveryEnabled: ({ cfg, accountId }) =>
    isSlackExecApprovalClientEnabled({ cfg, accountId }),
  resolveNativeDeliveryMode: ({ cfg, accountId }) =>
    resolveSlackExecApprovalTarget({ cfg, accountId }),
  requireMatchingTurnSourceChannel: true,
  resolveSuppressionAccountId: resolveSlackNativeSuppressionAccountId,
  resolveOriginTarget: resolveSlackOriginTarget,
  resolveApproverDmTargets: resolveSlackApproverDmTargets,
  notifyOriginWhenDmOnly: true,
  nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
    eventKinds: ["exec", "plugin"],
    isConfigured: ({ cfg, accountId }) =>
      isSlackAnyNativeApprovalClientEnabled({
        cfg,
        accountId,
      }),
    shouldHandle: ({ cfg, accountId, request }) =>
      shouldHandleSlackNativeApprovalRequest({
        cfg,
        accountId,
        approvalKind: resolveSlackApprovalKind(request),
        request,
      }),
    load: async () =>
      (await import("./approval-handler.runtime.js"))
        .slackApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter,
  }),
});

const baseSlackNativeAdapter = baseSlackApprovalCapability.native;

export const slackApprovalCapability: ChannelApprovalCapability = {
  ...baseSlackApprovalCapability,
  delivery: {
    ...baseSlackApprovalCapability.delivery,
    shouldSuppressForwardingFallback: (input) => {
      if (!shouldConsiderSlackNativeForwardingSuppression(input)) {
        return false;
      }
      const canHandleNative = shouldHandleSlackNativeApprovalRequest({
        cfg: input.cfg,
        accountId: resolveSlackNativeSuppressionAccountId(input),
        approvalKind: input.approvalKind,
        request: input.request,
      });
      if (!canHandleNative || input.approvalKind !== "plugin") {
        return canHandleNative;
      }
      return isSlackPluginForwardingFallbackHandledNatively(input);
    },
  },
  native: baseSlackNativeAdapter
    ? {
        ...baseSlackNativeAdapter,
        describeDeliveryCapabilities: (params) => {
          const capabilities = baseSlackNativeAdapter.describeDeliveryCapabilities(params);
          return {
            ...capabilities,
            enabled: shouldHandleSlackNativeApprovalRequest({
              cfg: params.cfg,
              accountId: params.accountId,
              approvalKind: params.approvalKind,
              request: params.request as ApprovalRequest,
            }),
          };
        },
      }
    : undefined,
};

export const slackNativeApprovalAdapter = splitChannelApprovalCapability(slackApprovalCapability);

export const testing = {
  resolveSessionSlackOriginTarget,
  resolveTurnSourceSlackOriginTarget,
  slackTargetsMatch,
};
