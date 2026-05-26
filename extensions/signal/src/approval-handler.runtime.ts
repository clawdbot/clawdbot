import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import {
  createChannelApprovalNativeRuntimeAdapter,
  type ExpiredApprovalView,
  type PendingApprovalView,
  type ResolvedApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import {
  buildExecApprovalPendingReplyPayload,
  type ExecApprovalPendingReplyParams,
  type ExecApprovalReplyDecision,
} from "openclaw/plugin-sdk/approval-reply-runtime";
import {
  buildApprovalResolvedReplyPayload,
  buildPluginApprovalExpiredMessage,
  buildPluginApprovalPendingReplyPayload,
  buildPluginApprovalResolvedMessage,
  type ExecApprovalRequest,
  type ExecApprovalResolved,
  type PluginApprovalRequest,
  type PluginApprovalResolved,
} from "openclaw/plugin-sdk/approval-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  addSignalApprovalReactionHintToText,
  buildSignalApprovalReactionHint,
  hasSignalApprovalReactionApprovers,
  registerSignalApprovalReactionTarget,
  resolveSignalApprovalConversationKey,
  resolveSignalApprovalTargetAuthorKeys,
  unregisterSignalApprovalReactionTarget,
} from "./approval-reactions.js";
import { normalizeSignalMessagingTarget } from "./normalize.js";
import { sendMessageSignal, sendTypingSignal } from "./send.js";

const log = createSubsystemLogger("signal/approvals");

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalResolved = ExecApprovalResolved | PluginApprovalResolved;
type SignalPendingDelivery = {
  text: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
};
type PreparedSignalApprovalTarget = {
  to: string;
  accountId: string;
  baseUrl?: string;
  account?: string;
  accountUuid?: string;
  targetAuthorKeys: readonly string[];
};
type PendingSignalApprovalEntry = {
  accountId: string;
  to: string;
  conversationKey: string;
  messageId: string;
  baseUrl?: string;
  account?: string;
  targetAuthorKeys: readonly string[];
};
type SignalFinalPayload = {
  text: string;
};

type SignalApprovalRuntimeContext = {
  baseUrl?: string;
  account?: string;
  accountUuid?: string;
};

function readSignalApprovalRuntimeContext(context: unknown): SignalApprovalRuntimeContext {
  const value = context as
    | { baseUrl?: unknown; account?: unknown; accountUuid?: unknown }
    | null
    | undefined;
  return {
    baseUrl:
      typeof value?.baseUrl === "string" && value.baseUrl.trim() ? value.baseUrl.trim() : undefined,
    account:
      typeof value?.account === "string" && value.account.trim() ? value.account.trim() : undefined,
    accountUuid:
      typeof value?.accountUuid === "string" && value.accountUuid.trim()
        ? value.accountUuid.trim()
        : undefined,
  };
}

function appendReactionHint(params: {
  cfg: Parameters<typeof hasSignalApprovalReactionApprovers>[0]["cfg"];
  accountId?: string | null;
  text: string;
  allowedDecisions: SignalPendingDelivery["allowedDecisions"];
  targetAuthorKeys: readonly string[];
}): string {
  if (
    params.targetAuthorKeys.length === 0 ||
    !hasSignalApprovalReactionApprovers({ cfg: params.cfg, accountId: params.accountId })
  ) {
    return params.text;
  }
  const hint = buildSignalApprovalReactionHint(params.allowedDecisions);
  return hint
    ? addSignalApprovalReactionHintToText({
        text: params.text,
        allowedDecisions: params.allowedDecisions,
      })
    : params.text;
}

function replaceApprovalIdPlaceholder(text: string | undefined, approvalId: string): string {
  return (text ?? "").replace(/\/approve\s+<id>/g, `/approve ${approvalId}`);
}

function buildPendingPayload(params: {
  cfg: Parameters<typeof hasSignalApprovalReactionApprovers>[0]["cfg"];
  accountId?: string | null;
  request: ApprovalRequest;
  approvalKind: "exec" | "plugin";
  nowMs: number;
  view: PendingApprovalView;
}): SignalPendingDelivery {
  const allowedDecisions = params.view.actions.map((action) => action.decision);
  const payload =
    params.approvalKind === "plugin"
      ? buildPluginApprovalPendingReplyPayload({
          request: params.request as PluginApprovalRequest,
          nowMs: params.nowMs,
          allowedDecisions,
        })
      : buildExecApprovalPendingReplyPayload({
          approvalId: params.request.id,
          approvalSlug: params.request.id.slice(0, 8),
          approvalCommandId: params.request.id,
          warningText:
            params.view.approvalKind === "exec"
              ? (params.view.warningText ?? undefined)
              : undefined,
          command: params.view.approvalKind === "exec" ? params.view.commandText : "",
          cwd: params.view.approvalKind === "exec" ? (params.view.cwd ?? undefined) : undefined,
          host:
            params.view.approvalKind === "exec" && params.view.host === "node" ? "node" : "gateway",
          nodeId:
            params.view.approvalKind === "exec" ? (params.view.nodeId ?? undefined) : undefined,
          allowedDecisions,
          expiresAtMs: params.request.expiresAtMs,
          nowMs: params.nowMs,
        } satisfies ExecApprovalPendingReplyParams);
  return {
    text: replaceApprovalIdPlaceholder(payload.text, params.request.id),
    allowedDecisions,
  };
}

function buildResolvedText(params: {
  request: ApprovalRequest;
  resolved: ApprovalResolved;
  view: ResolvedApprovalView;
}): string {
  if (params.view.approvalKind === "plugin") {
    return buildPluginApprovalResolvedMessage(params.resolved as PluginApprovalResolved);
  }
  const resolvedByText = params.resolved.resolvedBy
    ? ` Resolved by ${params.resolved.resolvedBy}.`
    : "";
  const payload = buildApprovalResolvedReplyPayload({
    approvalId: params.request.id,
    approvalSlug: params.request.id.slice(0, 8),
    text: `✅ Exec approval ${params.resolved.decision}.${resolvedByText} ID: ${params.request.id}`,
  });
  return payload.text ?? "";
}

function buildExpiredText(params: { request: ApprovalRequest; view: ExpiredApprovalView }): string {
  if (params.view.approvalKind === "plugin") {
    return buildPluginApprovalExpiredMessage(params.request as PluginApprovalRequest);
  }
  return `⏱️ Exec approval expired. ID: ${params.request.id}`;
}

function resolvePreparedAccountId(params: {
  plannedAccountId?: string | null;
  contextAccountId?: string | null;
}): string {
  return (
    normalizeOptionalString(params.plannedAccountId) ??
    normalizeOptionalString(params.contextAccountId) ??
    DEFAULT_ACCOUNT_ID
  );
}

export const signalApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  SignalPendingDelivery,
  PreparedSignalApprovalTarget,
  PendingSignalApprovalEntry,
  true,
  SignalFinalPayload
>({
  eventKinds: ["exec", "plugin"],
  availability: {
    isConfigured: ({ context }) => Boolean(context),
    shouldHandle: ({ context }) => Boolean(context),
  },
  presentation: {
    buildPendingPayload: ({ cfg, accountId, request, approvalKind, nowMs, view }) =>
      buildPendingPayload({ cfg, accountId, request, approvalKind, nowMs, view }),
    buildResolvedResult: ({ request, resolved, view }) => ({
      kind: "update",
      payload: { text: buildResolvedText({ request, resolved, view }) },
    }),
    buildExpiredResult: ({ request, view }) => ({
      kind: "update",
      payload: { text: buildExpiredText({ request, view }) },
    }),
  },
  transport: {
    prepareTarget: ({ plannedTarget, accountId, context }) => {
      const to = normalizeSignalMessagingTarget(plannedTarget.target.to);
      if (!to) {
        return null;
      }
      const runtimeContext = readSignalApprovalRuntimeContext(context);
      const targetAuthorKeys = resolveSignalApprovalTargetAuthorKeys({
        targetAuthor: runtimeContext.account,
        targetAuthorUuid: runtimeContext.accountUuid,
      });
      const prepared: PreparedSignalApprovalTarget = {
        to,
        accountId: resolvePreparedAccountId({
          plannedAccountId: (plannedTarget.target as { accountId?: string | null }).accountId,
          contextAccountId: accountId,
        }),
        ...(runtimeContext.baseUrl ? { baseUrl: runtimeContext.baseUrl } : {}),
        ...(runtimeContext.account ? { account: runtimeContext.account } : {}),
        ...(runtimeContext.accountUuid ? { accountUuid: runtimeContext.accountUuid } : {}),
        targetAuthorKeys,
      };
      return {
        dedupeKey: `${prepared.accountId}:${buildChannelApprovalNativeTargetKey({
          to: prepared.to,
        })}`,
        target: prepared,
      };
    },
    deliverPending: async ({ cfg, preparedTarget, pendingPayload }) => {
      await sendTypingSignal(preparedTarget.to, {
        cfg,
        accountId: preparedTarget.accountId,
        ...(preparedTarget.baseUrl ? { baseUrl: preparedTarget.baseUrl } : {}),
        ...(preparedTarget.account ? { account: preparedTarget.account } : {}),
      }).catch(() => {});
      const text = appendReactionHint({
        cfg,
        accountId: preparedTarget.accountId,
        text: pendingPayload.text,
        allowedDecisions: pendingPayload.allowedDecisions,
        targetAuthorKeys: preparedTarget.targetAuthorKeys,
      });
      const result = await sendMessageSignal(preparedTarget.to, text, {
        cfg,
        accountId: preparedTarget.accountId,
        ...(preparedTarget.baseUrl ? { baseUrl: preparedTarget.baseUrl } : {}),
        ...(preparedTarget.account ? { account: preparedTarget.account } : {}),
        textMode: "plain",
      });
      if (!result.messageId || result.messageId === "unknown") {
        return null;
      }
      const conversationKey = resolveSignalApprovalConversationKey(preparedTarget.to);
      if (!conversationKey) {
        return null;
      }
      return {
        accountId: preparedTarget.accountId,
        to: preparedTarget.to,
        conversationKey,
        messageId: result.messageId,
        targetAuthorKeys: preparedTarget.targetAuthorKeys,
        ...(preparedTarget.baseUrl ? { baseUrl: preparedTarget.baseUrl } : {}),
        ...(preparedTarget.account ? { account: preparedTarget.account } : {}),
      };
    },
    updateEntry: async ({ cfg, entry, payload }) => {
      await sendMessageSignal(entry.to, payload.text, {
        cfg,
        accountId: entry.accountId,
        ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
        ...(entry.account ? { account: entry.account } : {}),
        textMode: "plain",
      });
    },
  },
  interactions: {
    bindPending: ({ entry, request, view, pendingPayload }) =>
      registerSignalApprovalReactionTarget({
        accountId: entry.accountId,
        conversationKey: entry.conversationKey,
        messageId: entry.messageId,
        approvalId: request.id,
        allowedDecisions: pendingPayload.allowedDecisions,
        targetAuthorKeys: entry.targetAuthorKeys,
        route: {
          deliveryMode: "session",
          ...(normalizeOptionalString(request.request.agentId)
            ? { agentId: normalizeOptionalString(request.request.agentId) }
            : {}),
          ...(normalizeOptionalString(request.request.sessionKey)
            ? { sessionKey: normalizeOptionalString(request.request.sessionKey) }
            : {}),
        },
        routeAllowed: true,
        ttlMs: Math.max(1, view.expiresAtMs - Date.now()),
      })
        ? true
        : null,
    unbindPending: ({ entry }) => {
      unregisterSignalApprovalReactionTarget({
        accountId: entry.accountId,
        conversationKey: entry.conversationKey,
        messageId: entry.messageId,
      });
    },
    cancelDelivered: ({ entry }) => {
      unregisterSignalApprovalReactionTarget({
        accountId: entry.accountId,
        conversationKey: entry.conversationKey,
        messageId: entry.messageId,
      });
    },
  },
  observe: {
    onDeliveryError: ({ error, request }) => {
      log.error(`signal approvals: failed to send request ${request.id}: ${String(error)}`);
    },
  },
});
