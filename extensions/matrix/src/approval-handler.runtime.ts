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
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
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
import {
  reactMatrixMessage,
  sendMessageMatrix,
  sendSingleTextMessageMatrix,
} from "./matrix/send.js";
import { resolveMatrixTargetIdentity } from "./matrix/target-ids.js";
import type { CoreConfig } from "./types.js";

// OpenClaw Matrix custom event content for capable clients; body and reactions remain fallback.
const MATRIX_APPROVAL_METADATA_KEY = "com.openclaw.approval" as const;

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
type MatrixApprovalMetadataAction = {
  decision: ExecApprovalReplyDecision;
  label: string;
  style: PendingApprovalView["actions"][number]["style"];
  command: string;
};
type MatrixApprovalMetadataBase = {
  version: 1;
  type: "approval.request";
  id: string;
  state: "pending";
  kind: PendingApprovalView["approvalKind"];
  phase: "pending";
  title: string;
  description?: string;
  expiresAtMs: number;
  metadata: PendingApprovalView["metadata"];
  allowedDecisions: ExecApprovalReplyDecision[];
  actions: MatrixApprovalMetadataAction[];
};
type MatrixExecApprovalMetadata = MatrixApprovalMetadataBase & {
  kind: "exec";
  ask?: string;
  agentId?: string;
  commandText: string;
  commandPreview?: string;
  cwd?: string;
  envKeys?: readonly string[];
  host?: string;
  nodeId?: string;
  sessionKey?: string;
};
type MatrixPluginApprovalSeverity = Extract<
  PendingApprovalView,
  { approvalKind: "plugin" }
>["severity"];
type MatrixPluginApprovalMetadata = MatrixApprovalMetadataBase & {
  kind: "plugin";
  agentId?: string;
  pluginId?: string;
  toolName?: string;
  severity: MatrixPluginApprovalSeverity;
};
type MatrixApprovalMetadata = MatrixExecApprovalMetadata | MatrixPluginApprovalMetadata;
type MatrixApprovalExtraContent = {
  [MATRIX_APPROVAL_METADATA_KEY]: MatrixApprovalMetadata;
};
type PendingApprovalContent = {
  approvalId: string;
  text: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
  extraContent: MatrixApprovalExtraContent;
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
  sendSingleTextMessage?: typeof sendSingleTextMessageMatrix;
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

function isSingleMatrixMessageLimitError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("Matrix single-message text exceeds limit")
  );
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

function buildMatrixApprovalMetadata(params: {
  view: PendingApprovalView;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
}): MatrixApprovalMetadata {
  const base: MatrixApprovalMetadataBase = {
    version: 1,
    type: "approval.request",
    id: params.view.approvalId,
    state: "pending",
    kind: params.view.approvalKind,
    phase: params.view.phase,
    title: params.view.title,
    expiresAtMs: params.view.expiresAtMs,
    metadata: params.view.metadata,
    allowedDecisions: Array.from(params.allowedDecisions),
    actions: params.view.actions.map((action) => ({
      decision: action.decision,
      label: action.label,
      style: action.style,
      command: action.command,
    })),
    ...(params.view.description != null ? { description: params.view.description } : {}),
  };

  if (params.view.approvalKind === "plugin") {
    return {
      ...base,
      kind: "plugin",
      severity: params.view.severity,
      ...(params.view.agentId != null ? { agentId: params.view.agentId } : {}),
      ...(params.view.pluginId != null ? { pluginId: params.view.pluginId } : {}),
      ...(params.view.toolName != null ? { toolName: params.view.toolName } : {}),
    };
  }

  return {
    ...base,
    kind: "exec",
    commandText: params.view.commandText,
    ...(params.view.ask != null ? { ask: params.view.ask } : {}),
    ...(params.view.agentId != null ? { agentId: params.view.agentId } : {}),
    ...(params.view.commandPreview != null ? { commandPreview: params.view.commandPreview } : {}),
    ...(params.view.cwd != null ? { cwd: params.view.cwd } : {}),
    ...(params.view.envKeys != null ? { envKeys: params.view.envKeys } : {}),
    ...(params.view.host != null ? { host: params.view.host } : {}),
    ...(params.view.nodeId != null ? { nodeId: params.view.nodeId } : {}),
    ...(params.view.sessionKey != null ? { sessionKey: params.view.sessionKey } : {}),
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
    extraContent: {
      [MATRIX_APPROVAL_METADATA_KEY]: buildMatrixApprovalMetadata({
        view: params.view,
        allowedDecisions,
      }),
    },
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
    deliverPending: async ({ cfg, accountId, context, preparedTarget, pendingPayload, view }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return null;
      }
      const sendSingleTextMessage =
        resolved.context.deps?.sendSingleTextMessage ?? sendSingleTextMessageMatrix;
      const reactMessage = resolved.context.deps?.reactMessage ?? reactMatrixMessage;
      let result;
      try {
        result = await sendSingleTextMessage(preparedTarget.to, pendingPayload.text, {
          cfg: cfg as CoreConfig,
          accountId: resolved.accountId,
          client: resolved.context.client,
          threadId: preparedTarget.threadId,
          extraContent: pendingPayload.extraContent,
        });
      } catch (error) {
        if (!isSingleMatrixMessageLimitError(error)) {
          throw error;
        }
        const sendMessage = resolved.context.deps?.sendMessage ?? sendMessageMatrix;
        result = await sendMessage(preparedTarget.to, pendingPayload.text, {
          cfg: cfg as CoreConfig,
          accountId: resolved.accountId,
          client: resolved.context.client,
          threadId: preparedTarget.threadId,
          extraContent: pendingPayload.extraContent,
        });
      }
      const messageIds = Array.from(
        new Set(
          (result.messageIds ?? [result.messageId])
            .map((messageId) => messageId.trim())
            .filter(Boolean),
        ),
      );
      const reactionEventId =
        result.primaryMessageId?.trim() || messageIds[0] || result.messageId.trim();
      registerMatrixApprovalReactionTarget({
        roomId: result.roomId,
        eventId: reactionEventId,
        approvalId: pendingPayload.approvalId,
        allowedDecisions: pendingPayload.allowedDecisions,
        ttlMs: view.expiresAtMs - Date.now(),
      });
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
    bindPending: (params) => {
      const target = normalizeReactionTargetRef({
        roomId: params.entry.roomId,
        eventId: params.entry.reactionEventId,
      });
      if (!target) {
        return null;
      }
      registerMatrixApprovalReactionTarget({
        roomId: target.roomId,
        eventId: target.eventId,
        approvalId: params.pendingPayload.approvalId,
        allowedDecisions: params.pendingPayload.allowedDecisions,
        ttlMs: params.view.expiresAtMs - Date.now(),
      });
      return target;
    },
    unbindPending: (params) => {
      const target = normalizeReactionTargetRef(params.binding);
      if (!target) {
        return;
      }
      unregisterMatrixApprovalReactionTarget(target);
    },
  },
});
