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
import {
  registerWhatsAppApprovalReactionTarget,
  unregisterWhatsAppApprovalReactionTarget,
} from "./approval-reactions.js";
import { normalizeWhatsAppMessagingTarget } from "./normalize.js";
import { getWhatsAppRuntime } from "./runtime.js";
import { sendMessageWhatsApp, sendTypingWhatsApp } from "./send.js";

const log = createSubsystemLogger("whatsapp/approvals");

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type WhatsAppPendingDelivery = ApprovalReactionPendingContent;
type PreparedWhatsAppApprovalTarget = {
  to: string;
  accountId?: string;
};
type PendingWhatsAppApprovalEntry = {
  accountId?: string;
  to: string;
  remoteJid: string;
  messageId: string;
};
type WhatsAppFinalPayload = {
  text: string;
};

function buildPendingPayload(params: {
  request: ApprovalRequest;
  view: PendingApprovalView;
  nowMs: number;
}): WhatsAppPendingDelivery {
  return buildApprovalReactionPendingContent(params);
}

export const whatsappApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  WhatsAppPendingDelivery,
  PreparedWhatsAppApprovalTarget,
  PendingWhatsAppApprovalEntry,
  true,
  WhatsAppFinalPayload
>({
  eventKinds: ["exec", "plugin"],
  availability: {
    isConfigured: ({ context }) => Boolean(context),
    shouldHandle: ({ context }) => Boolean(context),
  },
  presentation: {
    buildPendingPayload: ({ request, nowMs, view }) =>
      buildPendingPayload({ request, view, nowMs }),
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
    prepareTarget: ({ plannedTarget, accountId }) => {
      const to = normalizeWhatsAppMessagingTarget(plannedTarget.target.to);
      if (!to) {
        return null;
      }
      const prepared: PreparedWhatsAppApprovalTarget = {
        to,
        accountId: resolvePreparedApprovalAccountId({
          plannedAccountId: (plannedTarget.target as { accountId?: string | null }).accountId,
          contextAccountId: accountId,
        }),
      };
      return {
        dedupeKey: `${prepared.accountId ?? ""}:${buildChannelApprovalNativeTargetKey({
          to: prepared.to,
        })}`,
        target: prepared,
      };
    },
    deliverPending: async ({ cfg, preparedTarget, pendingPayload }) => {
      const verbose = getWhatsAppRuntime().logging.shouldLogVerbose();
      await sendTypingWhatsApp(preparedTarget.to, {
        cfg,
        ...(preparedTarget.accountId ? { accountId: preparedTarget.accountId } : {}),
      }).catch(() => {});
      const result = await sendMessageWhatsApp(
        preparedTarget.to,
        pendingPayload.reactionPayload.text ?? "",
        {
          cfg,
          verbose,
          preserveLeadingWhitespace: true,
          ...(preparedTarget.accountId ? { accountId: preparedTarget.accountId } : {}),
        },
      );
      if (!result.messageId) {
        return null;
      }
      return {
        accountId: preparedTarget.accountId,
        to: preparedTarget.to,
        remoteJid: result.toJid,
        messageId: result.messageId,
      };
    },
    updateEntry: async ({ cfg, entry, payload }) => {
      const verbose = getWhatsAppRuntime().logging.shouldLogVerbose();
      await sendMessageWhatsApp(entry.to, payload.text, {
        cfg,
        verbose,
        preserveLeadingWhitespace: true,
        ...(entry.accountId ? { accountId: entry.accountId } : {}),
        quotedMessageKey: {
          id: entry.messageId,
          remoteJid: entry.remoteJid,
          fromMe: true,
        },
      });
    },
  },
  interactions: {
    bindPending: ({ entry, request, view, pendingPayload }) =>
      registerWhatsAppApprovalReactionTarget({
        accountId: entry.accountId ?? "",
        remoteJid: entry.remoteJid,
        messageId: entry.messageId,
        approvalId: request.id,
        allowedDecisions: pendingPayload.reactionPayload.allowedDecisions,
        ttlMs: Math.max(1, view.expiresAtMs - Date.now()),
      })
        ? true
        : null,
    unbindPending: ({ entry }) => {
      unregisterWhatsAppApprovalReactionTarget({
        accountId: entry.accountId ?? "",
        remoteJid: entry.remoteJid,
        messageId: entry.messageId,
      });
    },
    cancelDelivered: ({ entry }) => {
      unregisterWhatsAppApprovalReactionTarget({
        accountId: entry.accountId ?? "",
        remoteJid: entry.remoteJid,
        messageId: entry.messageId,
      });
    },
  },
  observe: {
    onDeliveryError: ({ error, request }) => {
      log.error(`whatsapp approvals: failed to send request ${request.id}: ${String(error)}`);
    },
  },
});
