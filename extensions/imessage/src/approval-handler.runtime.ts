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
  addIMessageApprovalReactionHintToText,
  registerIMessageApprovalReactionTarget,
  unregisterIMessageApprovalReactionTarget,
  type IMessageApprovalConversationKey,
} from "./approval-reactions.js";
import { replaceApprovalIdPlaceholder } from "./approval-text.js";
import { normalizeIMessageMessagingTarget } from "./normalize.js";
import { sendMessageIMessage } from "./send.js";
import { normalizeIMessageHandle, parseIMessageTarget } from "./targets.js";

const log = createSubsystemLogger("imessage/approvals");

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalResolved = ExecApprovalResolved | PluginApprovalResolved;
type IMessagePendingDelivery = {
  text: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
};
type PreparedIMessageApprovalTarget = {
  to: string;
  accountId?: string;
};
type PendingIMessageApprovalEntry = {
  accountId?: string;
  to: string;
  conversation: IMessageApprovalConversationKey;
  messageId: string;
};
type IMessageFinalPayload = {
  text: string;
};

function buildPendingPayload(params: {
  request: ApprovalRequest;
  approvalKind: "exec" | "plugin";
  nowMs: number;
  view: PendingApprovalView;
}): IMessagePendingDelivery {
  const allowedDecisions = params.view.actions.flatMap((action) =>
    action.kind === "decision" ? [action.decision] : [],
  );
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
          ask: params.view.approvalKind === "exec" ? (params.view.ask ?? null) : null,
          agentId: params.view.approvalKind === "exec" ? (params.view.agentId ?? null) : null,
          sessionKey: params.view.approvalKind === "exec" ? (params.view.sessionKey ?? null) : null,
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
    // Use the same hint-insertion helper as the render path so the two routes
    // produce identical prompt text and the helper's idempotency guard
    // prevents a double-hint when the upstream payload already includes one.
    text: addIMessageApprovalReactionHintToText({
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

function buildConversationKeyForTarget(to: string): IMessageApprovalConversationKey | null {
  try {
    const parsed = parseIMessageTarget(to);
    if (parsed.kind === "chat_id") {
      return { chatId: parsed.chatId };
    }
    if (parsed.kind === "chat_guid") {
      return { chatGuid: parsed.chatGuid };
    }
    if (parsed.kind === "chat_identifier") {
      return { chatIdentifier: parsed.chatIdentifier };
    }
    const handle = normalizeIMessageHandle(parsed.to);
    return handle ? { handle } : null;
  } catch {
    return null;
  }
}

export const imessageApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  IMessagePendingDelivery,
  PreparedIMessageApprovalTarget,
  PendingIMessageApprovalEntry,
  true,
  IMessageFinalPayload
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
      const to = normalizeIMessageMessagingTarget(plannedTarget.target.to);
      if (!to) {
        return null;
      }
      const prepared: PreparedIMessageApprovalTarget = {
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
      const result = await sendMessageIMessage(preparedTarget.to, pendingPayload.text, {
        config: cfg,
        ...(preparedTarget.accountId ? { accountId: preparedTarget.accountId } : {}),
      });
      // Approval reaction bindings must use the GUID-only id (matches the
      // inbound tapback's `reacted_to_guid`). When the bridge only returned a
      // numeric ROWID / `ok` / `unknown`, `result.guid` is undefined — refuse
      // to bind so the reaction shortcut won't silently miss a real tap.
      const guid = result.guid;
      if (!guid) {
        return null;
      }
      const conversation = buildConversationKeyForTarget(preparedTarget.to);
      if (!conversation) {
        return null;
      }
      return {
        ...(preparedTarget.accountId ? { accountId: preparedTarget.accountId } : {}),
        to: preparedTarget.to,
        conversation,
        messageId: guid,
      };
    },
    updateEntry: async ({ cfg, entry, payload }) => {
      await sendMessageIMessage(entry.to, payload.text, {
        config: cfg,
        ...(entry.accountId ? { accountId: entry.accountId } : {}),
        replyToId: entry.messageId,
      });
    },
  },
  interactions: {
    bindPending: ({ entry, request, view, pendingPayload }) => {
      const accountId = entry.accountId?.trim();
      if (!accountId) {
        // An empty accountId would silently fail buildReactionTargetKey and
        // leave the prompt with no way to be resolved via reaction. Surface
        // this loudly instead of returning null with no signal.
        log.error(
          `imessage approvals: refusing to bind reaction target for ${request.id}; missing accountId in prepared entry`,
        );
        return null;
      }
      // If the approval is already past expiry by the time we bind (clock skew
      // or delayed delivery), don't pretend to honor a 1ms TTL — refuse the
      // binding so callers see an honest "no binding" and the prompt remains
      // resolvable only via the /approve text fallback.
      const ttlMs = view.expiresAtMs - Date.now();
      if (ttlMs <= 0) {
        log.error(
          `imessage approvals: refusing to bind reaction target for ${request.id}; approval already expired at bind time`,
        );
        return null;
      }
      return registerIMessageApprovalReactionTarget({
        accountId,
        conversation: entry.conversation,
        messageId: entry.messageId,
        approvalId: request.id,
        allowedDecisions: pendingPayload.allowedDecisions,
        ttlMs,
      })
        ? true
        : null;
    },
    unbindPending: ({ entry }) => {
      const accountId = entry.accountId?.trim();
      if (!accountId) {
        return;
      }
      unregisterIMessageApprovalReactionTarget({
        accountId,
        conversation: entry.conversation,
        messageId: entry.messageId,
      });
    },
    cancelDelivered: ({ entry }) => {
      const accountId = entry.accountId?.trim();
      if (!accountId) {
        return;
      }
      unregisterIMessageApprovalReactionTarget({
        accountId,
        conversation: entry.conversation,
        messageId: entry.messageId,
      });
    },
  },
  observe: {
    onDeliveryError: ({ error, request }) => {
      log.error(`imessage approvals: failed to send request ${request.id}: ${String(error)}`);
    },
  },
});
