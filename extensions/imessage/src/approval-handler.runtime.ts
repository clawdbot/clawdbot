// Imessage plugin module implements approval handler behavior.
import {
  buildChannelApprovalExpiredText,
  buildChannelApprovalResolvedText,
  createChannelApprovalNativeRuntimeAdapter,
  type PendingApprovalView,
  resolvePreparedApprovalAccountId,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import { buildApprovalReactionPendingContent } from "openclaw/plugin-sdk/approval-reaction-runtime";
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  registerIMessageApprovalReactionTarget,
  unregisterIMessageApprovalReactionTarget,
  type IMessageApprovalConversationKey,
} from "./approval-reactions.js";
import { normalizeIMessageMessagingTarget } from "./normalize.js";
import { sendMessageIMessage } from "./send.js";
import { normalizeIMessageHandle, parseIMessageTarget } from "./targets.js";

const log = createSubsystemLogger("imessage/approvals");

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
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
  const pendingContent = buildApprovalReactionPendingContent({
    request: params.request,
    view: params.view as never,
    nowMs: params.nowMs,
  });
  return {
    text: pendingContent.reactionPayload.text ?? "",
    allowedDecisions: pendingContent.reactionPayload.allowedDecisions,
  };
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

function shouldThreadApprovalUpdate(to: string): boolean {
  try {
    const parsed = parseIMessageTarget(to);
    if (parsed.kind === "handle" && parsed.service === "sms") {
      return false;
    }
  } catch {
    return true;
  }
  return true;
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
      payload: { text: buildChannelApprovalResolvedText({ request, resolved, view }) },
    }),
    buildExpiredResult: ({ request, view }) => ({
      kind: "update",
      payload: { text: buildChannelApprovalExpiredText({ request, view }) },
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
        ...(shouldThreadApprovalUpdate(entry.to) ? { replyToId: entry.messageId } : {}),
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
