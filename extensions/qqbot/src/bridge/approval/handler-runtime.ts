/**
 * QQ Bot Native Approval Runtime Adapter.
 *
 * Implements the framework's ChannelApprovalNativeRuntimeSpec to deliver
 * approval requests as QQ messages with inline keyboard buttons and handle
 * resolved/expired lifecycle events.
 *
 * This file is lazily imported by capability.ts to avoid loading
 * heavy dependencies on the critical startup path.
 */

import type { ChannelApprovalNativeRuntimeSpec } from "openclaw/plugin-sdk/approval-handler-runtime";
import { createChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { resolveApprovalRequestSessionConversation } from "openclaw/plugin-sdk/approval-native-runtime";
import {
  buildExecApprovalText,
  buildPluginApprovalText,
  buildApprovalKeyboard,
  resolveApprovalTarget,
  type ExecApprovalRequest,
  type PluginApprovalRequest,
} from "../../engine/approval/index.js";
import { getMessageApi, accountToCreds } from "../../engine/messaging/sender.js";
import type { ChatScope, InlineKeyboard, MessageResponse } from "../../engine/types.js";
import {
  matchesQQBotApprovalAccount,
  resolveQQBotExecApprovalConfig,
  isQQBotExecApprovalClientEnabled,
  shouldHandleQQBotExecApprovalRequest,
} from "../../exec-approvals.js";
import { ensurePlatformAdapter } from "../bootstrap.js";
import { resolveQQBotAccount } from "../config.js";
import { getBridgeLogger } from "../logger.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;

type QQBotPendingEntry = {
  messageId?: string;
  targetType: ChatScope;
  targetId: string;
};

type QQBotPendingPayload = {
  text: string;
  keyboard: InlineKeyboard;
};

function isExecRequest(request: ApprovalRequest): request is ExecApprovalRequest {
  return "expiresAtMs" in request;
}

function resolveQQTarget(request: ApprovalRequest): { type: ChatScope; id: string } | null {
  const sessionConversation = resolveApprovalRequestSessionConversation({
    request: request as never,
    channel: "qqbot",
    bundledFallback: true,
  });

  const sessionKey = request.request.sessionKey ?? null;
  const turnSourceTo = request.request.turnSourceTo ?? null;

  const target = resolveApprovalTarget(sessionKey, turnSourceTo);
  if (target) {
    return target;
  }

  if (sessionConversation?.id) {
    const kind = sessionConversation.kind;
    const chatScope: ChatScope = kind === "group" ? "group" : "c2c";
    return { type: chatScope, id: sessionConversation.id };
  }

  return null;
}

type QQBotPreparedTarget = { type: ChatScope; id: string };

const qqbotApprovalRuntimeSpec: ChannelApprovalNativeRuntimeSpec<
  QQBotPendingPayload,
  QQBotPreparedTarget,
  QQBotPendingEntry
> = {
  eventKinds: ["exec", "plugin"],

  availability: {
    isConfigured: ({ cfg, accountId }) => {
      if (resolveQQBotExecApprovalConfig({ cfg, accountId }) !== undefined) {
        const result = isQQBotExecApprovalClientEnabled({ cfg, accountId });
        getBridgeLogger().debug?.(
          `[qqbot:approval-runtime] isConfigured(profile) accountId=${accountId} → ${result}`,
        );
        return result;
      }
      const account = resolveQQBotAccount(cfg, accountId ?? undefined);
      const result = account.enabled && account.secretSource !== "none";
      getBridgeLogger().debug?.(
        `[qqbot:approval-runtime] isConfigured(fallback) accountId=${accountId} enabled=${account.enabled} secretSource=${account.secretSource} → ${result}`,
      );
      return result;
    },
    shouldHandle: ({ cfg, accountId, request }) => {
      if (resolveQQBotExecApprovalConfig({ cfg, accountId }) !== undefined) {
        const result = shouldHandleQQBotExecApprovalRequest({ cfg, accountId, request });
        getBridgeLogger().debug?.(
          `[qqbot:approval-runtime] shouldHandle(profile) accountId=${accountId} → ${result}`,
        );
        return result;
      }
      const target = resolveQQTarget(request as ApprovalRequest);
      if (target === null) {
        getBridgeLogger().debug?.(
          `[qqbot:approval-runtime] shouldHandle(fallback) accountId=${accountId} target=null → false`,
        );
        return false;
      }
      const accountMatches = matchesQQBotApprovalAccount({
        cfg,
        accountId,
        request: request as ApprovalRequest,
      });
      getBridgeLogger().debug?.(
        `[qqbot:approval-runtime] shouldHandle(fallback) accountId=${accountId} target=${JSON.stringify(
          target,
        )} accountMatches=${accountMatches} → ${accountMatches}`,
      );
      return accountMatches;
    },
  },

  presentation: {
    buildPendingPayload: ({ request, view }) => {
      const req = request as ApprovalRequest;
      const text = isExecRequest(req) ? buildExecApprovalText(req) : buildPluginApprovalText(req);
      const keyboard = buildApprovalKeyboard(
        req.id,
        view.actions.map((action) => action.decision),
      );
      getBridgeLogger().debug?.(
        `[qqbot:approval-runtime] buildPendingPayload requestId=${req.id} kind=${
          isExecRequest(req) ? "exec" : "plugin"
        }`,
      );
      return { text, keyboard };
    },
    buildResolvedResult: () => ({ kind: "leave" }),
    buildExpiredResult: () => ({ kind: "leave" }),
  },

  transport: {
    prepareTarget: ({ request }) => {
      const target = resolveQQTarget(request as ApprovalRequest);
      getBridgeLogger().debug?.(
        `[qqbot:approval-runtime] prepareTarget requestId=${request.id} target=${JSON.stringify(target)}`,
      );
      if (!target) {
        return null;
      }
      return { target, dedupeKey: `${target.type}:${target.id}` };
    },

    deliverPending: async ({ cfg, accountId, preparedTarget, pendingPayload }) => {
      // Ensure the PlatformAdapter is registered — resolveQQBotAccount below
      // calls getPlatformAdapter() to resolve secret inputs.
      ensurePlatformAdapter();
      const account = resolveQQBotAccount(cfg, accountId ?? undefined);
      const creds = accountToCreds(account);
      const messageApi = getMessageApi(account.appId);

      let result: MessageResponse;
      try {
        getBridgeLogger().debug?.(
          `[qqbot:approval-runtime] deliverPending accountId=${accountId} target=${preparedTarget.type}:${preparedTarget.id}`,
        );
        result = await messageApi.sendMessage(
          preparedTarget.type,
          preparedTarget.id,
          pendingPayload.text,
          creds,
          { inlineKeyboard: pendingPayload.keyboard },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to send approval message to ${preparedTarget.type}:${preparedTarget.id}: ${msg}`,
          { cause: err },
        );
      }

      getBridgeLogger().debug?.(
        `[qqbot:approval-runtime] deliverPending success accountId=${accountId} messageId=${result.id ?? ""}`,
      );
      return {
        messageId: result.id,
        targetType: preparedTarget.type,
        targetId: preparedTarget.id,
      };
    },
  },
};

export const qqbotApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter(
  qqbotApprovalRuntimeSpec,
) as unknown as ChannelApprovalNativeRuntimeAdapter;
