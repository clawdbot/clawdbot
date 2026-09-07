// Signal plugin module implements approval native behavior.
import { createApproverRestrictedNativeApprovalCapabilityFromForwardingRoutes } from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { shouldSuppressLocalNativeExecApprovalPrompt } from "openclaw/plugin-sdk/approval-native-runtime";
import { buildApprovalReactionPendingContentForRequest } from "openclaw/plugin-sdk/approval-reaction-runtime";
import type {
  ChannelApprovalCapability,
  ChannelOutboundPayloadHint,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "./accounts.js";
import { getSignalApprovalApprovers, signalApprovalAuth } from "./approval-auth.js";
import { normalizeSignalMessagingTarget } from "./normalize.js";

function isSignalApprovalTransportEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return resolveSignalAccount({ cfg: params.cfg, accountId: params.accountId }).enabled;
}

const signalApproval = createApproverRestrictedNativeApprovalCapabilityFromForwardingRoutes({
  channel: "signal",
  channelLabel: "Signal",
  authorizeActorAction: (params) => signalApprovalAuth.authorizeActorAction(params),
  routing: {
    defaultForwardingMode: "session",
    isTransportEnabled: isSignalApprovalTransportEnabled,
    listAccountIds: listSignalAccountIds,
    resolveDefaultAccountId: resolveDefaultSignalAccountId,
    normalizeTo: normalizeSignalMessagingTarget,
    resolveApprovers: getSignalApprovalApprovers,
    suppressExplicitTargetFallback: false,
    // Group conversations require explicit approvers; implicit same-chat auth
    // would otherwise let any participant approve the request.
    isOriginTargetAllowed: ({ cfg, accountId, target }) =>
      !isSignalGroupTarget(target.to) || getSignalApprovalApprovers({ cfg, accountId }).length > 0,
  },
  describeExecApprovalSetup: ({ accountId }) => {
    const prefix =
      accountId && accountId !== "default"
        ? `channels.signal.accounts.${accountId}`
        : "channels.signal";
    return `Signal supports native exec approvals for this account when \`approvals.exec.enabled\` is true and the route allows Signal. Link Signal and keep the gateway running; configure \`${prefix}.allowFrom\` to restrict approvers.`;
  },
  render: {
    exec: {
      buildPendingPayload: ({ request, nowMs }) =>
        buildApprovalReactionPendingContentForRequest({ request, nowMs }).manualFallbackPayload,
    },
    plugin: {
      buildPendingPayload: ({ request, nowMs }) =>
        buildApprovalReactionPendingContentForRequest({ request, nowMs }).manualFallbackPayload,
    },
  },
  createNativeRuntime: (routing) =>
    createLazyChannelApprovalNativeRuntimeAdapter({
      eventKinds: ["exec", "plugin", "system-agent"],
      isConfigured: ({ cfg, accountId, context }) =>
        Boolean(context) && routing.isNativeApprovalHandlerConfigured({ cfg, accountId }),
      shouldHandle: ({ cfg, accountId, context, approvalKind, request }) =>
        Boolean(context) &&
        routing.shouldHandleApprovalRequest({ cfg, accountId, approvalKind, request }),
      load: async () =>
        (await import("./approval-handler.runtime.js"))
          .signalApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter,
    }),
});
const signalApprovalRouting = signalApproval.routing;

export function isSignalNativeApprovalHandlerConfigured(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return signalApprovalRouting.isNativeApprovalHandlerConfigured(params);
}

function resolveSignalSessionTargetFromSessionKey(sessionKey?: string | null): string | null {
  const parsed = parseAgentSessionKey(sessionKey);
  const rest = parsed?.rest ?? normalizeOptionalString(sessionKey);
  if (!rest || !normalizeLowercaseStringOrEmpty(rest).startsWith("signal:")) {
    return null;
  }
  return normalizeSignalMessagingTarget(rest.slice("signal:".length)) ?? null;
}

export function shouldSuppressLocalSignalExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
  hint?: ChannelOutboundPayloadHint;
}): boolean {
  return shouldSuppressLocalNativeExecApprovalPrompt({
    ...params,
    isTransportEnabled: isSignalApprovalTransportEnabled,
    isSessionRouteEligible: ({ cfg, accountId, metadata }) => {
      if (getSignalApprovalApprovers({ cfg, accountId }).length > 0) {
        return true;
      }
      const sessionTarget = resolveSignalSessionTargetFromSessionKey(metadata.sessionKey);
      return Boolean(sessionTarget && !isSignalGroupTarget(sessionTarget));
    },
  });
}

function isSignalGroupTarget(to: string): boolean {
  return normalizeLowercaseStringOrEmpty(to).startsWith("group:");
}

export const signalApprovalCapability: ChannelApprovalCapability = signalApproval.capability;
