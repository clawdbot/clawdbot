import type { ReplyPayload } from "../../auto-reply/types.js";
import type {
  ChannelMessageUnknownSendContext,
  ChannelMessageUnknownSendReconciliationResult,
  RenderedMessageBatchPlan,
} from "../../channels/message/types.js";
import type { ReplyToMode } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../errors.js";
import { resolveOutboundChannelMessageAdapter } from "./channel-resolution.js";

type UnknownSendQueueEntry = {
  id: string;
  channel: string;
  to: string;
  accountId?: string;
  enqueuedAt: number;
  retryCount: number;
  platformSendStartedAt?: number;
  effectiveReplyToId?: string | null;
  renderedBatchPlan?: RenderedMessageBatchPlan;
  replyToId?: string | null;
  replyToMode?: ReplyToMode;
  threadId?: string | number | null;
  silent?: boolean;
  session?: { agentId?: string };
};

export function buildUnknownSendContext(params: {
  entry: UnknownSendQueueEntry;
  payloads: readonly ReplyPayload[];
  cfg: OpenClawConfig;
}): ChannelMessageUnknownSendContext {
  const { entry } = params;
  return {
    cfg: params.cfg,
    queueId: entry.id,
    channel: entry.channel,
    to: entry.to,
    ...(entry.accountId !== undefined ? { accountId: entry.accountId } : {}),
    enqueuedAt: entry.enqueuedAt,
    retryCount: entry.retryCount,
    ...(entry.platformSendStartedAt !== undefined
      ? { platformSendStartedAt: entry.platformSendStartedAt }
      : {}),
    ...(entry.effectiveReplyToId !== undefined
      ? { effectiveReplyToId: entry.effectiveReplyToId }
      : {}),
    payloads: params.payloads,
    ...(entry.renderedBatchPlan ? { renderedBatchPlan: entry.renderedBatchPlan } : {}),
    ...(entry.replyToId !== undefined ? { replyToId: entry.replyToId } : {}),
    ...(entry.replyToMode !== undefined ? { replyToMode: entry.replyToMode } : {}),
    ...(entry.threadId !== undefined ? { threadId: entry.threadId } : {}),
    ...(entry.silent !== undefined ? { silent: entry.silent } : {}),
  };
}

/** Reconciles provider state without applying or rediscovering outbound policy. */
export async function reconcileUnknownQueuedDelivery(params: {
  entry: UnknownSendQueueEntry;
  payloads: readonly ReplyPayload[];
  cfg: OpenClawConfig;
  warn: (message: string) => void;
}): Promise<ChannelMessageUnknownSendReconciliationResult | null> {
  const adapter = resolveOutboundChannelMessageAdapter({
    channel: params.entry.channel,
    cfg: params.cfg,
    agentId: params.entry.session?.agentId,
    allowBootstrap: true,
  });
  if (adapter?.durableFinal?.capabilities?.reconcileUnknownSend !== true) {
    return null;
  }
  const reconcileUnknownSend = adapter.durableFinal.reconcileUnknownSend;
  if (!reconcileUnknownSend) {
    return null;
  }
  const { entry } = params;
  try {
    return await reconcileUnknownSend(buildUnknownSendContext(params));
  } catch (error) {
    const message = formatErrorMessage(error);
    params.warn(`Delivery entry ${entry.id} unknown-send reconciliation failed: ${message}`);
    return { status: "unresolved", error: message, retryable: true };
  }
}
