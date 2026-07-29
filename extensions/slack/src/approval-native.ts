// Slack plugin module implements approval native behavior.
import { createApproverRestrictedNativeApprovalCapability } from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createChannelNativeOriginTargetResolver,
  createNativeApprovalForwardingFallbackSuppressor,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import { normalizeMessageChannel } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { listSlackAccountIds } from "./accounts.js";
import { getSlackApprovalApprovers, isSlackApprovalAuthorizedSender } from "./approval-auth.js";
import {
  hasSlackPluginApprovers,
  isSlackAnyNativeApprovalClientEnabled,
  normalizeSlackForwardTarget,
  normalizeSlackOriginTarget,
  resolveSessionSlackOriginTarget,
  resolveSlackFallbackOriginTarget,
  resolveTurnSourceSlackOriginTarget,
  shouldHandleSlackNativeApprovalRequest,
  shouldHandleSlackPluginViaForwardingSession,
  slackTargetsMatch,
  type SlackApprovalKind,
  type SlackNativeApprovalRequest,
  type SlackOriginTarget,
} from "./approval-native-gates.js";
import {
  getSlackExecApprovalApprovers,
  isSlackExecApprovalAuthorizedSender,
  isSlackExecApprovalClientEnabled,
  resolveSlackExecApprovalTarget,
} from "./exec-approvals.js";

type ApprovalRequest = SlackNativeApprovalRequest;
type ApprovalKind = SlackApprovalKind;
type SlackSuppressionAccountInput = {
  target: { channel: string; accountId?: string | null };
  request: {
    request: {
      turnSourceChannel?: string | null;
      turnSourceAccountId?: string | null;
    };
  };
};

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

const resolveSlackOriginTarget = createChannelNativeOriginTargetResolver({
  channel: "slack",
  shouldHandleRequest: ({ cfg, accountId, approvalKind, request }) =>
    shouldHandleSlackNativeApprovalRequest({
      cfg,
      accountId,
      approvalKind,
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

const shouldSuppressSlackForwardingFallback =
  createNativeApprovalForwardingFallbackSuppressor<SlackOriginTarget>({
    channel: "slack",
    normalizeForwardTarget: normalizeSlackForwardTarget,
    resolveAccountId: ({ target, request }) =>
      resolveSlackNativeSuppressionAccountId({ target, request }),
    isSessionRouteEligible: shouldHandleSlackNativeApprovalRequest,
    isExplicitTargetEligible: shouldHandleSlackNativeApprovalRequest,
    resolveOriginTarget: resolveSlackOriginTarget,
    resolveApproverDmTargets: resolveSlackApproverDmTargets,
    targetsMatch: slackTargetsMatch,
  });

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
    shouldHandle: ({ cfg, accountId, approvalKind, request }) =>
      shouldHandleSlackNativeApprovalRequest({
        cfg,
        accountId,
        approvalKind,
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
      return shouldSuppressSlackForwardingFallback(input);
    },
  },
  native: baseSlackNativeAdapter
    ? {
        ...baseSlackNativeAdapter,
        describeDeliveryCapabilities: (params) => {
          const capabilities = baseSlackNativeAdapter.describeDeliveryCapabilities(params);
          const request = params.request as ApprovalRequest;
          const approvalKind = params.approvalKind;
          return {
            ...capabilities,
            enabled: shouldHandleSlackNativeApprovalRequest({
              cfg: params.cfg,
              accountId: params.accountId,
              approvalKind,
              request,
            }),
            ...(approvalKind === "plugin" &&
            shouldHandleSlackPluginViaForwardingSession({
              cfg: params.cfg,
              accountId: params.accountId,
              request,
            })
              ? {
                  preferredSurface: "origin" as const,
                  supportsApproverDmSurface: hasSlackPluginApprovers({
                    cfg: params.cfg,
                    accountId: params.accountId,
                  }),
                }
              : {}),
          };
        },
      }
    : undefined,
};
