import {
  createApproverRestrictedNativeApprovalCapability,
  splitChannelApprovalCapability,
} from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { listTelegramAccountIds } from "./accounts.js";
import {
  getTelegramExecApprovalApprovers,
  isTelegramExecApprovalApprover,
  isTelegramExecApprovalAuthorizedSender,
  isTelegramExecApprovalClientEnabled,
  isTelegramExecApprovalTargetRecipient,
  resolveTelegramExecApprovalTarget,
  shouldHandleTelegramExecApprovalRequest,
} from "./exec-approvals.js";
import { parseTelegramThreadId } from "./outbound-params.js";
import { normalizeTelegramChatId, parseTelegramTarget } from "./targets.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type TelegramOriginTarget = { to: string; threadId?: number };

function resolveTurnSourceTelegramOriginTarget(
  request: ApprovalRequest,
): TelegramOriginTarget | null {
  const turnSourceChannel = normalizeLowercaseStringOrEmpty(request.request.turnSourceChannel);
  const rawTurnSourceTo = normalizeOptionalString(request.request.turnSourceTo) ?? "";
  const parsedTurnSourceTarget = rawTurnSourceTo ? parseTelegramTarget(rawTurnSourceTo) : null;
  const turnSourceTo = normalizeTelegramChatId(parsedTurnSourceTarget?.chatId ?? rawTurnSourceTo);
  if (turnSourceChannel !== "telegram" || !turnSourceTo) {
    return null;
  }
  const rawThreadId =
    request.request.turnSourceThreadId ?? parsedTurnSourceTarget?.messageThreadId ?? undefined;
  return {
    to: turnSourceTo,
    threadId: parseTelegramThreadId(rawThreadId),
  };
}

function resolveSessionTelegramOriginTarget(sessionTarget: {
  to: string;
  threadId?: string | number | null;
}): TelegramOriginTarget {
  return {
    to: normalizeTelegramChatId(sessionTarget.to) ?? sessionTarget.to,
    threadId: parseTelegramThreadId(sessionTarget.threadId),
  };
}

const resolveTelegramOriginTarget = createChannelNativeOriginTargetResolver({
  channel: "telegram",
  shouldHandleRequest: ({ cfg, accountId, request }) =>
    shouldHandleTelegramExecApprovalRequest({
      cfg,
      accountId,
      request,
    }),
  resolveTurnSourceTarget: resolveTurnSourceTelegramOriginTarget,
  resolveSessionTarget: resolveSessionTelegramOriginTarget,
});

const resolveTelegramApproverDmTargets = createChannelApproverDmTargetResolver({
  shouldHandleRequest: ({ cfg, accountId, request }) =>
    shouldHandleTelegramExecApprovalRequest({
      cfg,
      accountId,
      request,
    }),
  resolveApprovers: getTelegramExecApprovalApprovers,
  mapApprover: (approver) => ({ to: approver }),
});

const telegramNativeApprovalCapability = createApproverRestrictedNativeApprovalCapability({
  channel: "telegram",
  channelLabel: "Telegram",
  describeExecApprovalSetup: ({ accountId }: { accountId?: string | null }) => {
    const prefix =
      accountId && accountId !== "default"
        ? `channels.telegram.accounts.${accountId}`
        : "channels.telegram";
    return `Approve it from the Web UI or terminal UI for now. Telegram supports native exec approvals for this account. Configure \`${prefix}.execApprovals.approvers\` or \`commands.ownerAllowFrom\`; leave \`${prefix}.execApprovals.enabled\` unset/\`auto\` or set it to \`true\`.`;
  },
  listAccountIds: listTelegramAccountIds,
  hasApprovers: ({ cfg, accountId }) =>
    getTelegramExecApprovalApprovers({ cfg, accountId }).length > 0,
  isExecAuthorizedSender: ({ cfg, accountId, senderId }) =>
    isTelegramExecApprovalAuthorizedSender({ cfg, accountId, senderId }),
  isPluginAuthorizedSender: ({ cfg, accountId, senderId }) =>
    isTelegramExecApprovalApprover({ cfg, accountId, senderId }),
  isNativeDeliveryEnabled: ({ cfg, accountId }) =>
    isTelegramExecApprovalClientEnabled({ cfg, accountId }),
  resolveNativeDeliveryMode: ({ cfg, accountId }) =>
    resolveTelegramExecApprovalTarget({ cfg, accountId }),
  requireMatchingTurnSourceChannel: true,
  resolveSuppressionAccountId: ({ target, request }) =>
    normalizeOptionalString(target.accountId) ??
    normalizeOptionalString(request.request.turnSourceAccountId),
  resolveOriginTarget: resolveTelegramOriginTarget,
  resolveApproverDmTargets: resolveTelegramApproverDmTargets,
  notifyOriginWhenDmOnly: true,
  nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
    eventKinds: ["exec", "plugin"],
    isConfigured: ({ cfg, accountId }) =>
      isTelegramExecApprovalClientEnabled({
        cfg,
        accountId,
      }),
    shouldHandle: ({ cfg, accountId, request }) =>
      shouldHandleTelegramExecApprovalRequest({
        cfg,
        accountId,
        request,
      }),
    load: async () =>
      (await import("./approval-handler.runtime.js"))
        .telegramApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter,
  }),
});

const resolveTelegramApproveCommandBehavior: NonNullable<
  ChannelApprovalCapability["resolveApproveCommandBehavior"]
> = (
  params: Parameters<NonNullable<ChannelApprovalCapability["resolveApproveCommandBehavior"]>>[0],
) => {
  const { cfg, accountId, senderId, approvalKind } = params;
  if (approvalKind !== "exec") {
    return undefined;
  }
  if (isTelegramExecApprovalClientEnabled({ cfg, accountId })) {
    return undefined;
  }
  if (isTelegramExecApprovalTargetRecipient({ cfg, accountId, senderId })) {
    return undefined;
  }
  if (
    isTelegramExecApprovalAuthorizedSender({ cfg, accountId, senderId }) &&
    !isTelegramExecApprovalApprover({ cfg, accountId, senderId })
  ) {
    return undefined;
  }
  return {
    kind: "reply",
    text: "❌ Telegram exec approvals are not enabled for this bot account.",
  };
};

export const telegramApprovalCapability: ChannelApprovalCapability = {
  ...telegramNativeApprovalCapability,
  resolveApproveCommandBehavior: resolveTelegramApproveCommandBehavior,
};

export const telegramNativeApprovalAdapter = splitChannelApprovalCapability(
  telegramApprovalCapability,
);
