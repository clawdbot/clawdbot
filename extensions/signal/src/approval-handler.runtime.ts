// Signal plugin module implements approval handler behavior.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import {
  buildChannelApprovalExpiredText,
  buildChannelApprovalResolvedText,
  createChannelApprovalNativeRuntimeAdapter,
  type PendingApprovalView,
  resolvePreparedApprovalAccountId,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import {
  buildApprovalReactionPendingContent,
  type ApprovalReactionPendingContent,
} from "openclaw/plugin-sdk/approval-reaction-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
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
type SignalPendingDelivery = ApprovalReactionPendingContent;
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
  reactionsActive: boolean;
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

function buildPendingPayload(params: {
  request: ApprovalRequest;
  nowMs: number;
  view: PendingApprovalView;
}): SignalPendingDelivery {
  return buildApprovalReactionPendingContent(params);
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
    buildPendingPayload: ({ request, nowMs, view }) =>
      buildPendingPayload({ request, nowMs, view }),
    buildResolvedResult: ({ request, resolved, view }) => ({
      kind: "update",
      payload: { text: buildChannelApprovalResolvedText({ request, resolved, view }) },
    }),
    buildExpiredResult: ({ request, view }) => ({
      kind: "update",
      payload: { text: buildChannelApprovalExpiredText({ request, view }) },
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
        accountId: resolvePreparedApprovalAccountId({
          plannedAccountId: (plannedTarget.target as { accountId?: string | null }).accountId,
          contextAccountId: accountId,
          fallbackAccountId: DEFAULT_ACCOUNT_ID,
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
      const reactionsActive =
        preparedTarget.targetAuthorKeys.length > 0 &&
        hasSignalApprovalReactionApprovers({ cfg, accountId: preparedTarget.accountId });
      const payload = reactionsActive
        ? pendingPayload.reactionPayload
        : pendingPayload.manualFallbackPayload;
      const result = await sendMessageSignal(preparedTarget.to, payload.text ?? "", {
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
        reactionsActive,
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
    bindPending: ({ entry, request, view, pendingPayload }) => {
      if (!entry.reactionsActive) {
        return null;
      }
      return registerSignalApprovalReactionTarget({
        accountId: entry.accountId,
        conversationKey: entry.conversationKey,
        messageId: entry.messageId,
        approvalId: request.id,
        allowedDecisions: pendingPayload.reactionPayload.allowedDecisions,
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
        : null;
    },
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
