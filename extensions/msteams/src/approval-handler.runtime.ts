import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import {
  createChannelApprovalNativeRuntimeAdapter,
  resolvePreparedApprovalAccountId,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  registerMSTeamsApprovalCardBinding,
  unregisterMSTeamsApprovalCardBindings,
} from "./approval-card-actions.js";
import {
  buildMSTeamsExpiredApprovalCard,
  buildMSTeamsPendingApprovalCard,
  buildMSTeamsResolvedApprovalCard,
  type MSTeamsApprovalActionToken,
} from "./approval-card.js";
import {
  isMSTeamsNativeApprovalClientEnabled,
  shouldHandleMSTeamsNativeApprovalRequest,
} from "./approval-native.js";
import { extractMSTeamsConversationMessageId } from "./inbound.js";
import { normalizeMSTeamsMessagingTarget } from "./resolve-allowlist.js";
import { editAdaptiveCardMSTeams, sendAdaptiveCardMSTeams, sendMessageMSTeams } from "./send.js";
import { inferMSTeamsTargetChatType } from "./session-route.js";

const log = createSubsystemLogger("msteams/approvals");

type MSTeamsPendingDelivery = ReturnType<typeof buildMSTeamsPendingApprovalCard>;

type MSTeamsPendingEntry = {
  accountId: string;
  conversationId: string;
  activityId: string;
  actionTokens: readonly MSTeamsApprovalActionToken[];
};

export const msTeamsApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  MSTeamsPendingDelivery,
  { to: string },
  MSTeamsPendingEntry,
  readonly string[],
  Record<string, unknown>
>({
  eventKinds: ["exec", "plugin"],
  availability: {
    isConfigured: ({ cfg, accountId }) => isMSTeamsNativeApprovalClientEnabled({ cfg, accountId }),
    shouldHandle: ({ cfg, accountId, approvalKind, request }) =>
      shouldHandleMSTeamsNativeApprovalRequest({ cfg, accountId, approvalKind, request }),
  },
  presentation: {
    buildPendingPayload: ({ view, nowMs }) => buildMSTeamsPendingApprovalCard({ view, nowMs }),
    buildResolvedResult: ({ view }) => ({
      kind: "update",
      payload: buildMSTeamsResolvedApprovalCard(view),
    }),
    buildExpiredResult: ({ view }) => ({
      kind: "update",
      payload: buildMSTeamsExpiredApprovalCard(view),
    }),
  },
  transport: {
    prepareTarget: ({ plannedTarget }) => {
      const normalizedTarget = normalizeMSTeamsMessagingTarget(plannedTarget.target.to);
      if (!normalizedTarget) {
        throw new Error("Microsoft Teams approval delivery target is missing");
      }
      const threadId = plannedTarget.target.threadId;
      const to =
        threadId != null &&
        inferMSTeamsTargetChatType(normalizedTarget) === "channel" &&
        !extractMSTeamsConversationMessageId(normalizedTarget)
          ? `${normalizedTarget};messageid=${threadId}`
          : normalizedTarget;
      return {
        dedupeKey: buildChannelApprovalNativeTargetKey({
          ...plannedTarget.target,
          to: normalizedTarget,
        }),
        target: { to },
      };
    },
    deliverPending: async ({ cfg, accountId, preparedTarget, pendingPayload }) => {
      const deliveryAccountId = resolvePreparedApprovalAccountId({
        contextAccountId: accountId,
        fallbackAccountId: DEFAULT_ACCOUNT_ID,
      });
      const sent = await sendAdaptiveCardMSTeams({
        cfg,
        accountId: deliveryAccountId,
        to: preparedTarget.to,
        card: pendingPayload.card,
      });
      if (!sent.messageId || sent.messageId === "unknown" || !sent.conversationId) {
        return null;
      }
      return {
        accountId: deliveryAccountId,
        conversationId: sent.conversationId,
        activityId: sent.messageId,
        actionTokens: pendingPayload.actionTokens,
      };
    },
    updateEntry: async ({ cfg, entry, payload }) => {
      await editAdaptiveCardMSTeams({
        cfg,
        accountId: entry.accountId,
        to: entry.conversationId,
        activityId: entry.activityId,
        card: payload,
      });
    },
  },
  interactions: {
    bindPending: ({ entry, request, approvalKind, view, pendingPayload }) => {
      const tokens: string[] = [];
      for (const actionToken of entry.actionTokens) {
        if (
          registerMSTeamsApprovalCardBinding({
            token: actionToken.token,
            accountId: entry.accountId,
            approvalId: request.id,
            approvalKind,
            decision: actionToken.decision,
            allowedDecisions: pendingPayload.allowedDecisions,
            conversationId: entry.conversationId,
            activityId: entry.activityId,
            expiresAtMs: view.expiresAtMs,
          })
        ) {
          tokens.push(actionToken.token);
        }
      }
      return tokens.length > 0 ? tokens : null;
    },
    unbindPending: ({ binding }) => unregisterMSTeamsApprovalCardBindings(binding),
    cancelDelivered: ({ entry }) =>
      unregisterMSTeamsApprovalCardBindings(entry.actionTokens.map(({ token }) => token)),
  },
  observe: {
    onDeliveryError: ({
      cfg,
      accountId,
      error,
      plannedTarget,
      request,
      approvalKind,
      pendingPayload,
    }) => {
      log.error(`msteams approvals: failed to deliver request ${request.id}: ${String(error)}`);
      // The active native route suppressed the local text prompt, so a failed
      // card send must still surface a visible approval path (#130040 tracks
      // the shared-boundary fix); losing both prompts is a silent failure.
      const decisions = pendingPayload.allowedDecisions.join("|");
      void sendMessageMSTeams({
        cfg,
        accountId: resolvePreparedApprovalAccountId({
          contextAccountId: accountId,
          fallbackAccountId: DEFAULT_ACCOUNT_ID,
        }),
        to: plannedTarget.target.to,
        text: `⚠️ Could not deliver the ${approvalKind} approval card for ${request.id}. Reply "/approve ${request.id} <${decisions}>" to resolve it.`,
      }).catch((fallbackError: unknown) => {
        log.error(
          `msteams approvals: fallback prompt for ${request.id} also failed: ${String(fallbackError)}`,
        );
      });
    },
  },
});
