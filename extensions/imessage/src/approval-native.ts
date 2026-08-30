// Imessage plugin module implements approval native behavior.
import { createApproverRestrictedNativeApprovalCapabilityFromForwardingRoutes } from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { shouldSuppressLocalNativeExecApprovalPrompt } from "openclaw/plugin-sdk/approval-native-runtime";
import { addApprovalReactionHintToText } from "openclaw/plugin-sdk/approval-reaction-runtime";
import {
  buildTypedExecApprovalPendingReplyPayload,
  buildTypedPluginApprovalPendingReplyPayload,
} from "openclaw/plugin-sdk/approval-reply-runtime";
import {
  getExecApprovalReplyMetadata,
  resolveExecApprovalCommandDisplay,
  resolveExecApprovalRequestAllowedDecisions,
} from "openclaw/plugin-sdk/approval-runtime";
import type {
  ExecApprovalRequest,
  ExecApprovalReplyDecision,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type {
  ChannelApprovalCapability,
  ChannelOutboundPayloadHint,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeAccountId, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  listIMessageAccountIds,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
} from "./accounts.js";
import { getIMessageApprovalApprovers, imessageApprovalAuth } from "./approval-auth.js";
import { replaceApprovalIdPlaceholder } from "./approval-text.js";
import { normalizeIMessageMessagingTarget } from "./normalize.js";
import { inferIMessageTargetChatType } from "./targets.js";

const DEFAULT_PLUGIN_APPROVAL_DECISIONS: readonly ExecApprovalReplyDecision[] = [
  "allow-once",
  "allow-always",
  "deny",
];

function isIMessageApprovalTransportEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return resolveIMessageAccount({ cfg: params.cfg, accountId: params.accountId }).enabled;
}

const imessageApproval = createApproverRestrictedNativeApprovalCapabilityFromForwardingRoutes({
  channel: "imessage",
  channelLabel: "iMessage",
  authorizeActorAction: (params) => imessageApprovalAuth.authorizeActorAction(params),
  routing: {
    defaultForwardingMode: "session",
    isTransportEnabled: isIMessageApprovalTransportEnabled,
    listAccountIds: listIMessageAccountIds,
    resolveDefaultAccountId: resolveDefaultIMessageAccountId,
    normalizeTo: normalizeIMessageMessagingTarget,
    resolveApprovers: getIMessageApprovalApprovers,
    // Group conversations require explicit approvers; implicit same-chat auth
    // would otherwise let any participant approve the request.
    isOriginTargetAllowed: ({ cfg, accountId, target }) =>
      inferIMessageTargetChatType(target.to) !== "group" ||
      getIMessageApprovalApprovers({ cfg, accountId }).length > 0,
  },
  describeExecApprovalSetup: ({ accountId }) => {
    const prefix =
      accountId && accountId !== "default"
        ? `channels.imessage.accounts.${accountId}`
        : "channels.imessage";
    return `iMessage supports native exec approvals for this account when \`approvals.exec.enabled\` is true and the route allows iMessage. Keep the macOS imsg bridge running and configure \`${prefix}.allowFrom\` to restrict approvers.`;
  },
  render: {
    exec: {
      buildPendingPayload: ({ request, nowMs }) =>
        buildIMessageExecPendingPayload({ request, nowMs }),
    },
    plugin: {
      buildPendingPayload: ({ request, nowMs }) =>
        buildIMessagePluginPendingPayload({ request, nowMs }),
    },
  },
  createNativeRuntime: (routing) =>
    createLazyChannelApprovalNativeRuntimeAdapter({
      eventKinds: ["exec", "plugin"],
      isConfigured: ({ cfg, accountId, context }) =>
        Boolean(context) &&
        routing.canAnyApprovalPotentiallyRouteToChannel({
          cfg,
          accountId,
          nativeSessionOnly: true,
        }),
      shouldHandle: ({ cfg, accountId, context, approvalKind, request }) =>
        Boolean(context) &&
        routing.shouldHandleApprovalRequest({ cfg, accountId, approvalKind, request }),
      load: async () =>
        (await import("./approval-handler.runtime.js"))
          .imessageApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter,
    }),
});
const imessageApprovalRouting = imessageApproval.routing;

function resolveIMessageSessionTargetFromSessionKey(sessionKey?: string | null) {
  const parsed = parseAgentSessionKey(sessionKey);
  const rest = parsed?.rest ?? normalizeOptionalString(sessionKey);
  if (!rest || !normalizeLowercaseStringOrEmpty(rest).startsWith("imessage:")) {
    return null;
  }
  const route = rest.slice("imessage:".length).trim();
  const routeLower = normalizeLowercaseStringOrEmpty(route);
  if (
    !route ||
    routeLower.startsWith("group:") ||
    routeLower.startsWith("channel:") ||
    routeLower.startsWith("chat:")
  ) {
    return null;
  }

  const directPrefix = "direct:";
  if (routeLower.startsWith(directPrefix)) {
    const to = normalizeIMessageMessagingTarget(route.slice(directPrefix.length));
    return to ? { to } : null;
  }

  const accountScopedDirect = /^([^:]+):direct:(.+)$/i.exec(route);
  if (accountScopedDirect) {
    const to = normalizeIMessageMessagingTarget(accountScopedDirect[2] ?? "");
    return to ? { to, accountId: normalizeAccountId(accountScopedDirect[1] ?? "") } : null;
  }

  const to = normalizeIMessageMessagingTarget(route);
  if (!to || inferIMessageTargetChatType(to) !== "direct") {
    return null;
  }
  return { to };
}

export function shouldSuppressLocalIMessageExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
  hint?: ChannelOutboundPayloadHint;
}): boolean {
  if (
    shouldSuppressLocalNativeExecApprovalPrompt({
      ...params,
      isTransportEnabled: isIMessageApprovalTransportEnabled,
      isSessionRouteEligible: ({ cfg, accountId, metadata }) => {
        if (getIMessageApprovalApprovers({ cfg, accountId }).length > 0) {
          return true;
        }
        const sessionTarget = resolveIMessageSessionTargetFromSessionKey(metadata.sessionKey);
        if (!sessionTarget || inferIMessageTargetChatType(sessionTarget.to) !== "direct") {
          return false;
        }
        const targetAccountId = normalizeOptionalString(sessionTarget.accountId);
        return (
          !targetAccountId ||
          !accountId ||
          normalizeAccountId(targetAccountId) === normalizeAccountId(accountId)
        );
      },
    })
  ) {
    return true;
  }

  const metadata = getExecApprovalReplyMetadata(params.payload);
  if (
    params.hint?.kind !== "approval-pending" ||
    params.hint.approvalKind !== "exec" ||
    params.hint.nativeRouteActive !== true ||
    metadata?.approvalKind !== "exec"
  ) {
    return false;
  }

  // The Pi tool-result path currently rebuilds the local approval prompt from
  // exec result details that omit agentId/sessionKey. The native iMessage
  // approval runtime has already received the full request and will deliver the
  // reaction prompt. When explicit iMessage approvers exist, keep the local
  // fallback from sending a second manual prompt for the same approval.
  if (metadata.agentId || metadata.sessionKey) {
    return false;
  }
  if (getIMessageApprovalApprovers({ cfg: params.cfg, accountId: params.accountId }).length === 0) {
    return false;
  }
  return imessageApprovalRouting.canApprovalPotentiallyRouteToChannel({
    ...params,
    approvalKind: "exec",
    nativeSessionOnly: true,
  });
}

function appendIMessageReactionHint(params: {
  text?: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
}): string {
  return addApprovalReactionHintToText({
    text: params.text ?? "",
    allowedDecisions: params.allowedDecisions,
  });
}

function buildIMessageExecPendingPayload(params: { request: ExecApprovalRequest; nowMs: number }) {
  const allowedDecisions = resolveExecApprovalRequestAllowedDecisions(params.request.request);
  const command = resolveExecApprovalCommandDisplay(params.request.request).commandText;
  const payload = buildTypedExecApprovalPendingReplyPayload({
    approvalId: params.request.id,
    approvalSlug: params.request.id.slice(0, 8),
    approvalCommandId: params.request.id,
    warningText: params.request.request.warningText ?? undefined,
    ask: params.request.request.ask ?? null,
    agentId: params.request.request.agentId ?? null,
    allowedDecisions,
    command,
    cwd: params.request.request.cwd ?? undefined,
    host: params.request.request.host === "node" ? "node" : "gateway",
    nodeId: params.request.request.nodeId ?? undefined,
    scope: params.request.request.scope ?? undefined,
    sessionKey: params.request.request.sessionKey ?? null,
    expiresAtMs: params.request.expiresAtMs,
    nowMs: params.nowMs,
  });
  return {
    ...payload,
    text: appendIMessageReactionHint({
      text: replaceApprovalIdPlaceholder(payload.text, params.request.id),
      allowedDecisions,
    }),
  };
}

function buildIMessagePluginPendingPayload(params: {
  request: PluginApprovalRequest;
  nowMs: number;
}) {
  const configuredDecisions = params.request.request.allowedDecisions;
  const allowedDecisions =
    configuredDecisions && configuredDecisions.length > 0
      ? configuredDecisions
      : DEFAULT_PLUGIN_APPROVAL_DECISIONS;
  const payload = buildTypedPluginApprovalPendingReplyPayload({
    request: params.request,
    nowMs: params.nowMs,
    allowedDecisions,
  });
  return {
    ...payload,
    text: appendIMessageReactionHint({
      text: replaceApprovalIdPlaceholder(payload.text, params.request.id),
      allowedDecisions,
    }),
  };
}

export const imessageApprovalCapability: ChannelApprovalCapability = imessageApproval.capability;
