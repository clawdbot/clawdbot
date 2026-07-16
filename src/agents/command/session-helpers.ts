import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveAgentDeliveryPlan,
  resolveAgentOutboundTarget,
} from "../../infra/outbound/agent-delivery.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import {
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../../utils/delivery-context.shared.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
} from "../../utils/message-channel.js";
import type { AgentRunSessionTarget } from "../run-session-target.js";
import { persistSessionEntry as persistSessionEntryBase } from "./attempt-execution.shared.js";
import type { AgentCommandOpts } from "./types.js";

type PersistSessionEntryParams = {
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath: string;
  initialEntry: SessionEntry;
  entry: SessionEntry;
};

export async function persistSessionEntry(
  params: PersistSessionEntryParams & {
    shouldPersist?: (entry: SessionEntry | undefined) => boolean;
  },
): Promise<SessionEntry | undefined> {
  return await persistSessionEntryBase(params);
}

export function clearPendingFinalDeliveryFields(
  entry: SessionEntry,
  updatedAt: number,
): SessionEntry {
  return {
    ...entry,
    pendingFinalDelivery: undefined,
    pendingFinalDeliveryText: undefined,
    pendingFinalDeliveryCreatedAt: undefined,
    pendingFinalDeliveryLastAttemptAt: undefined,
    pendingFinalDeliveryAttemptCount: undefined,
    pendingFinalDeliveryLastError: undefined,
    pendingFinalDeliveryContext: undefined,
    pendingFinalDeliveryIntentId: undefined,
    restartRecoveryForceSafeTools: undefined,
    restartRecoveryDeliveryMediaUrls: undefined,
    restartRecoveryDisableMessageTool: undefined,
    restartRecoverySuppressTextDelivery: undefined,
    updatedAt,
  };
}

export async function resolveCurrentRunDeliveryContext(params: {
  cfg: OpenClawConfig;
  opts: AgentCommandOpts;
  sessionEntry?: SessionEntry;
}): Promise<DeliveryContext | undefined> {
  const { cfg, opts, sessionEntry } = params;
  if (opts.deliver !== true) {
    return undefined;
  }
  // Restart recovery only needs durable route fields; final delivery resolves plugin-specific routes.
  const deliveryPlan = resolveAgentDeliveryPlan({
    sessionEntry,
    requestedChannel: opts.replyChannel ?? opts.channel,
    explicitTo: opts.replyTo ?? opts.to,
    explicitThreadId: opts.threadId,
    accountId: opts.replyAccountId ?? opts.accountId,
    wantsDelivery: true,
    turnSourceChannel: opts.runContext?.messageChannel ?? opts.messageChannel,
    turnSourceTo: opts.runContext?.currentChannelId ?? opts.to,
    turnSourceAccountId: opts.runContext?.accountId ?? opts.accountId,
    turnSourceThreadId: opts.runContext?.currentThreadTs ?? opts.threadId,
  });
  const explicitChannelHint = normalizeOptionalString(opts.replyChannel ?? opts.channel);
  const explicitThreadId =
    opts.threadId != null && opts.threadId !== "" ? opts.threadId : undefined;
  let effectivePlan = deliveryPlan;
  if (deliveryPlan.resolvedChannel === INTERNAL_MESSAGE_CHANNEL && !explicitChannelHint) {
    try {
      const selection = await resolveMessageChannelSelection({ cfg });
      effectivePlan = {
        ...deliveryPlan,
        resolvedChannel: selection.channel,
        deliveryTargetMode: deliveryPlan.deliveryTargetMode ?? "implicit",
      };
    } catch {
      return undefined;
    }
  }
  if (!isDeliverableMessageChannel(effectivePlan.resolvedChannel)) {
    return undefined;
  }
  const targetMode =
    opts.deliveryTargetMode ??
    effectivePlan.deliveryTargetMode ??
    (opts.to ? "explicit" : "implicit");
  const resolvedTo =
    effectivePlan.resolvedTo ??
    resolveAgentOutboundTarget({
      cfg,
      plan: effectivePlan,
      targetMode,
      validateExplicitTarget: false,
    }).resolvedTo;
  if (!resolvedTo) {
    return undefined;
  }
  const threadId =
    targetMode === "explicit"
      ? (explicitThreadId ??
        (effectivePlan.baseDelivery.threadIdSource === "explicit"
          ? effectivePlan.resolvedThreadId
          : undefined))
      : effectivePlan.resolvedThreadId;
  return normalizeDeliveryContext({
    channel: effectivePlan.resolvedChannel,
    to: resolvedTo,
    accountId: effectivePlan.resolvedAccountId,
    threadId,
  });
}

export function createAgentCommandSessionWorkingCopy(params: {
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
}): {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
} {
  const result: {
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
  } = {};
  if (params.sessionEntry) {
    result.sessionEntry = { ...params.sessionEntry };
  }
  if (params.sessionStore || params.sessionKey) {
    result.sessionStore = {};
  }
  if (params.sessionKey && result.sessionEntry && result.sessionStore) {
    result.sessionStore[params.sessionKey] = result.sessionEntry;
  }
  return result;
}

export function resolveInternalSessionEffectsSource(params: {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
}):
  | Required<Pick<AgentRunSessionTarget, "agentId" | "sessionId" | "sessionKey" | "storePath">>
  | undefined {
  if (!params.storePath || !params.sessionKey) {
    return undefined;
  }
  return {
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  };
}
