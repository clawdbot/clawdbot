import type {
  ChannelApprovalCapabilityHandlerContext,
  PendingApprovalView,
  ResolvedApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { createChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import {
  buildExecApprovalPendingReplyPayload,
  buildPluginApprovalPendingReplyPayload,
  type ExecApprovalReplyDecision,
} from "openclaw/plugin-sdk/approval-reply-runtime";
import { buildPluginApprovalResolvedReplyPayload } from "openclaw/plugin-sdk/approval-runtime";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import {
  buildMatrixApprovalReactionHint,
  listMatrixApprovalReactionBindings,
  registerMatrixApprovalReactionTarget,
  unregisterMatrixApprovalReactionTarget,
} from "./approval-reactions.js";
import {
  isMatrixAnyApprovalClientEnabled,
  shouldHandleMatrixApprovalRequest,
} from "./exec-approvals.js";
import { resolveMatrixAccount } from "./matrix/accounts.js";
import { deleteMatrixMessage, editMatrixMessage } from "./matrix/actions/messages.js";
import { repairMatrixDirectRooms } from "./matrix/direct-management.js";
import type { MatrixClient } from "./matrix/sdk.js";
import { reactMatrixMessage, sendMessageMatrix } from "./matrix/send.js";
import { resolveMatrixTargetIdentity } from "./matrix/target-ids.js";
import type { CoreConfig } from "./types.js";

type PendingMessage = {
  roomId: string;
  messageIds: readonly string[];
  reactionEventId: string;
};
type PreparedMatrixTarget = {
  to: string;
  roomId: string;
  threadId?: string;
};
type PendingApprovalContent = {
  approvalId: string;
  text: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
};
type ReactionTargetRef = {
  roomId: string;
  eventId: string;
};
type MatrixRawApprovalTarget = {
  to: string;
  threadId?: string | number | null;
};
type MatrixPrepareTargetParams = {
  cfg: CoreConfig;
  accountId?: string | null;
  gatewayUrl?: string;
  context?: unknown;
  rawTarget: MatrixRawApprovalTarget;
};

export type MatrixApprovalHandlerDeps = {
  nowMs?: () => number;
  sendMessage?: typeof sendMessageMatrix;
  reactMessage?: typeof reactMatrixMessage;
  editMessage?: typeof editMatrixMessage;
  deleteMessage?: typeof deleteMatrixMessage;
  repairDirectRooms?: typeof repairMatrixDirectRooms;
};

export type MatrixApprovalHandlerContext = {
  client: MatrixClient;
  deps?: MatrixApprovalHandlerDeps;
};

function resolveHandlerContext(params: ChannelApprovalCapabilityHandlerContext): {
  accountId: string;
  context: MatrixApprovalHandlerContext;
} | null {
  const context = params.context as MatrixApprovalHandlerContext | undefined;
  const accountId = params.accountId?.trim() || "";
  if (!context?.client || !accountId) {
    return null;
  }
  return { accountId, context };
}

function normalizePendingMessageIds(entry: PendingMessage): string[] {
  return Array.from(new Set(entry.messageIds.map((messageId) => messageId.trim()).filter(Boolean)));
}

function normalizeReactionTargetRef(params: ReactionTargetRef): ReactionTargetRef | null {
  const roomId = params.roomId.trim();
  const eventId = params.eventId.trim();
  if (!roomId || !eventId) {
    return null;
  }
  return { roomId, eventId };
}

function normalizeThreadId(value?: string | number | null): string | undefined {
  const trimmed = value == null ? "" : String(value).trim();
  return trimmed || undefined;
}

async function prepareTarget(
  params: MatrixPrepareTargetParams,
): Promise<PreparedMatrixTarget | null> {
  const resolved = resolveHandlerContext(params);
  if (!resolved) {
    return null;
  }
  const target = resolveMatrixTargetIdentity(params.rawTarget.to);
  if (!target) {
    return null;
  }
  const threadId = normalizeThreadId(params.rawTarget.threadId);
  if (target.kind === "user") {
    const account = resolveMatrixAccount({
      cfg: params.cfg,
      accountId: resolved.accountId,
    });
    const repairDirectRooms = resolved.context.deps?.repairDirectRooms ?? repairMatrixDirectRooms;
    const repaired = await repairDirectRooms({
      client: resolved.context.client,
      remoteUserId: target.id,
      encrypted: account.config.encryption === true,
    });
    if (!repaired.activeRoomId) {
      return null;
    }
    return {
      to: `room:${repaired.activeRoomId}`,
      roomId: repaired.activeRoomId,
      threadId,
    };
  }
  return {
    to: `room:${target.id}`,
    roomId: target.id,
    threadId,
  };
}

function buildPendingApprovalContent(params: {
  view: PendingApprovalView;
  nowMs: number;
}): PendingApprovalContent {
  const allowedDecisions = params.view.actions.map((action) => action.decision);
  const payload =
    params.view.approvalKind === "plugin"
      ? buildPluginApprovalPendingReplyPayload({
          request: {
            id: params.view.approvalId,
            request: {
              title: params.view.title,
              description: params.view.description ?? "",
              severity: params.view.severity,
              toolName: params.view.toolName ?? undefined,
              pluginId: params.view.pluginId ?? undefined,
              agentId: params.view.agentId ?? undefined,
            },
            createdAtMs: 0,
            expiresAtMs: params.view.expiresAtMs,
          } satisfies PluginApprovalRequest,
          nowMs: params.nowMs,
          allowedDecisions,
        })
      : buildExecApprovalPendingReplyPayload({
          approvalId: params.view.approvalId,
          approvalSlug: params.view.approvalId.slice(0, 8),
          approvalCommandId: params.view.approvalId,
          ask: params.view.ask ?? undefined,
          agentId: params.view.agentId ?? undefined,
          allowedDecisions,
          command: params.view.commandText,
          cwd: params.view.cwd ?? undefined,
          host: params.view.host === "node" ? "node" : "gateway",
          nodeId: params.view.nodeId ?? undefined,
          sessionKey: params.view.sessionKey ?? undefined,
          expiresAtMs: params.view.expiresAtMs,
          nowMs: params.nowMs,
        });
  const hint = buildMatrixApprovalReactionHint(allowedDecisions);
  const text = payload.text ?? "";
  return {
    approvalId: params.view.approvalId,
    text: hint ? (text ? `${hint}\n\n${text}` : hint) : text,
    allowedDecisions,
  };
}

function buildResolvedApprovalText(view: ResolvedApprovalView): string {
  if (view.approvalKind === "plugin") {
    return (
      buildPluginApprovalResolvedReplyPayload({
        resolved: {
          id: view.approvalId,
          decision: view.decision,
          resolvedBy: view.resolvedBy ?? undefined,
          ts: 0,
        },
      }).text ?? ""
    );
  }
  const decisionLabel =
    view.decision === "allow-once"
      ? "Allowed once"
      : view.decision === "allow-always"
        ? "Allowed always"
        : "Denied";
  return [
    `Exec approval: ${decisionLabel}`,
    "",
    "Command",
    buildMarkdownCodeBlock(view.commandText),
  ].join("\n");
}

function buildMarkdownCodeBlock(text: string): string {
  const longestFence = Math.max(...Array.from(text.matchAll(/`+/g), (match) => match[0].length), 0);
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return [fence, text, fence].join("\n");
}

export const matrixApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  PendingApprovalContent,
  PreparedMatrixTarget,
  PendingMessage,
  ReactionTargetRef,
  string
>({
  eventKinds: ["exec", "plugin"],
  availability: {
    isConfigured: ({ cfg, accountId, context }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return false;
      }
      return isMatrixAnyApprovalClientEnabled({
        cfg,
        accountId: resolved.accountId,
      });
    },
    shouldHandle: ({ cfg, accountId, request, context }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return false;
      }
      return shouldHandleMatrixApprovalRequest({
        cfg,
        accountId: resolved.accountId,
        request: request as ExecApprovalRequest | PluginApprovalRequest,
      });
    },
  },
  presentation: {
    buildPendingPayload: ({ view, nowMs }) =>
      buildPendingApprovalContent({
        view,
        nowMs,
      }),
    buildResolvedResult: ({ view }) => ({
      kind: "update",
      payload: buildResolvedApprovalText(view),
    }),
    buildExpiredResult: () => ({ kind: "delete" }),
  },
  transport: {
    prepareTarget: ({ cfg, accountId, context, plannedTarget }) => {
      return prepareTarget({
        cfg,
        accountId,
        context,
        rawTarget: plannedTarget.target,
      }).then((preparedTarget) =>
        preparedTarget
          ? {
              dedupeKey: buildChannelApprovalNativeTargetKey({
                to: preparedTarget.roomId,
                threadId: preparedTarget.threadId,
              }),
              target: preparedTarget,
            }
          : null,
      );
    },
    deliverPending: async ({ cfg, accountId, context, preparedTarget, pendingPayload }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return null;
      }
      const sendMessage = resolved.context.deps?.sendMessage ?? sendMessageMatrix;
      const reactMessage = resolved.context.deps?.reactMessage ?? reactMatrixMessage;
      const result = await sendMessage(preparedTarget.to, pendingPayload.text, {
        cfg: cfg as CoreConfig,
        accountId: resolved.accountId,
        client: resolved.context.client,
        threadId: preparedTarget.threadId,
      });
      const messageIds = Array.from(
        new Set(
          (result.messageIds ?? [result.messageId])
            .map((messageId) => messageId.trim())
            .filter(Boolean),
        ),
      );
      const reactionEventId =
        result.primaryMessageId?.trim() || messageIds[0] || result.messageId.trim();
      await Promise.allSettled(
        listMatrixApprovalReactionBindings(pendingPayload.allowedDecisions).map(
          async ({ emoji }) => {
            await reactMessage(result.roomId, reactionEventId, emoji, {
              cfg: cfg as CoreConfig,
              accountId: resolved.accountId,
              client: resolved.context.client,
            });
          },
        ),
      );
      return {
        roomId: result.roomId,
        messageIds,
        reactionEventId,
      };
    },
    updateEntry: async ({ cfg, accountId, context, entry, payload }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return;
      }
      const editMessage = resolved.context.deps?.editMessage ?? editMatrixMessage;
      const deleteMessage = resolved.context.deps?.deleteMessage ?? deleteMatrixMessage;
      const [primaryMessageId, ...staleMessageIds] = normalizePendingMessageIds(entry);
      if (!primaryMessageId) {
        return;
      }
      const text = payload;
      await Promise.allSettled([
        editMessage(entry.roomId, primaryMessageId, text, {
          cfg: cfg as CoreConfig,
          accountId: resolved.accountId,
          client: resolved.context.client,
        }),
        ...staleMessageIds.map(async (messageId) => {
          await deleteMessage(entry.roomId, messageId, {
            cfg: cfg as CoreConfig,
            accountId: resolved.accountId,
            client: resolved.context.client,
            reason: "approval resolved",
          });
        }),
      ]);
    },
    deleteEntry: async ({ cfg, accountId, context, entry, phase }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return;
      }
      const deleteMessage = resolved.context.deps?.deleteMessage ?? deleteMatrixMessage;
      await Promise.allSettled(
        normalizePendingMessageIds(entry).map(async (messageId) => {
          await deleteMessage(entry.roomId, messageId, {
            cfg: cfg as CoreConfig,
            accountId: resolved.accountId,
            client: resolved.context.client,
            reason: phase === "expired" ? "approval expired" : "approval resolved",
          });
        }),
      );
    },
  },
  interactions: {
    bindPending: ({ entry, pendingPayload }) => {
      const target = normalizeReactionTargetRef({
        roomId: entry.roomId,
        eventId: entry.reactionEventId,
      });
      if (!target) {
        return null;
      }
      registerMatrixApprovalReactionTarget({
        roomId: target.roomId,
        eventId: target.eventId,
        approvalId: pendingPayload.approvalId,
        allowedDecisions: pendingPayload.allowedDecisions,
      });
      return target;
    },
    unbindPending: ({ binding }) => {
      const target = normalizeReactionTargetRef(binding);
      if (!target) {
        return;
      }
      unregisterMatrixApprovalReactionTarget(target);
    },
  },
});
