import {
  createChannelApprovalNativeRuntimeAdapter,
  type ExpiredApprovalView,
  type PendingApprovalView,
  type ResolvedApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import {
  buildExecApprovalPendingReplyPayload,
  type ExecApprovalReplyDecision,
  type ExecApprovalPendingReplyParams,
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
  buildWhatsAppApprovalReactionHint,
  registerWhatsAppApprovalReactionTarget,
  unregisterWhatsAppApprovalReactionTarget,
} from "./approval-reactions.js";
import { normalizeWhatsAppMessagingTarget } from "./normalize.js";
import { getWhatsAppRuntime } from "./runtime.js";
import { sendMessageWhatsApp, sendTypingWhatsApp } from "./send.js";

const log = createSubsystemLogger("whatsapp/approvals");

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalResolved = ExecApprovalResolved | PluginApprovalResolved;
type WhatsAppPendingDelivery = {
  text: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
};
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

function appendReactionHint(params: {
  text: string;
  allowedDecisions: WhatsAppPendingDelivery["allowedDecisions"];
}): string {
  const hint = buildWhatsAppApprovalReactionHint(params.allowedDecisions);
  return hint ? `${params.text}\n\n${hint}` : params.text;
}

function replaceApprovalIdPlaceholder(text: string | undefined, approvalId: string): string {
  return (text ?? "").replace(/\/approve\s+<id>/g, `/approve ${approvalId}`);
}

function buildPendingPayload(params: {
  request: ApprovalRequest;
  approvalKind: "exec" | "plugin";
  nowMs: number;
  view: PendingApprovalView;
}): WhatsAppPendingDelivery {
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
    text: appendReactionHint({
      text: replaceApprovalIdPlaceholder(payload.text, params.request.id),
      allowedDecisions,
    }),
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
}): string | undefined {
  return (
    normalizeOptionalString(params.plannedAccountId) ??
    normalizeOptionalString(params.contextAccountId)
  );
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
    buildPendingPayload: ({ request, approvalKind, nowMs, view }) =>
      buildPendingPayload({ request, approvalKind, nowMs, view }),
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
    prepareTarget: ({ plannedTarget, accountId }) => {
      const to = normalizeWhatsAppMessagingTarget(plannedTarget.target.to);
      if (!to) {
        return null;
      }
      const prepared: PreparedWhatsAppApprovalTarget = {
        to,
        accountId: resolvePreparedAccountId({
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
      const result = await sendMessageWhatsApp(preparedTarget.to, pendingPayload.text, {
        cfg,
        verbose,
        preserveLeadingWhitespace: true,
        ...(preparedTarget.accountId ? { accountId: preparedTarget.accountId } : {}),
      });
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
        allowedDecisions: pendingPayload.allowedDecisions,
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
