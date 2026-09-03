import type { TurnAdoptionLifecycle } from "../../auto-reply/get-reply-options.types.js";
import type { QueuedFollowupReplyBatch } from "../../auto-reply/reply/queue/types.js";
import {
  completeQueuedChatTurn,
  registerQueuedChatTurn,
  retireQueuedChatTurnCancellation,
  type QueuedChatTurnMap,
} from "../chat-queued-turns.js";
import { createChatSendLateFollowupDisposition } from "./chat-send-late-followup.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { createChatSendLateReplyFinalizer } from "./chat-send-source-finalization.js";
import { normalizeOptionalChatText } from "./chat-text-normalization.js";
import type { GatewayRequestContext } from "./types.js";

export function createChatSendTurnAdoptionLifecycle(params: {
  accountId: string | undefined;
  chatQueuedTurns: QueuedChatTurnMap;
  context: GatewayRequestContext;
  runId: string;
  controller: AbortController;
  sessionBinding: { readonly sessionId: string };
  sessionKey: string;
  agentId?: string;
  ownerConnId?: string;
  ownerDeviceId?: string;
  ownerKey?: string;
  originatingLeafEntryId?: string | null;
  originatingChannel: string;
  session: Pick<
    PreparedChatSendSession,
    "agentId" | "backingSessionId" | "cfg" | "clientRunId" | "sessionKey" | "sessionLoadOptions"
  >;
  hasCronCreatorAuthority: boolean;
  retainWorkAdmission: () => () => void;
}): {
  lifecycle: TurnAdoptionLifecycle;
  isEnqueued: () => boolean;
  onQueueDisposition: (reason: string) => void;
  onQueuedFollowupReplyBatch: (batch: QueuedFollowupReplyBatch) => Promise<void>;
} {
  let enqueued = false;
  let releaseWorkAdmission: (() => void) | undefined;
  const lateFollowup = createChatSendLateFollowupDisposition({
    runId: params.runId,
    originatingChannel: params.originatingChannel,
    logGateway: params.context.logGateway,
    deliver: createChatSendLateReplyFinalizer({
      accountId: params.accountId,
      context: params.context,
      session: params.session,
    }),
  });
  const lifecycle: TurnAdoptionLifecycle = {
    // Gateway cancel identity only — share collect key via ownerKey.
    admission: "cancel-only",
    abortSignal: params.controller.signal,
    ...(params.originatingLeafEntryId !== undefined
      ? { originatingLeafEntryId: params.originatingLeafEntryId }
      : {}),
    ownerKey: params.ownerKey,
    onAdopted: async () => {},
    onDeferred: () => {
      if (params.hasCronCreatorAuthority) {
        lifecycle.cronCreatorAuthorityUnavailable = "queued-local-operator";
      }
      enqueued = registerQueuedChatTurn({
        chatQueuedTurns: params.chatQueuedTurns,
        runId: params.runId,
        controller: params.controller,
        sessionId: params.sessionBinding.sessionId,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        ownerConnId: normalizeOptionalChatText(params.ownerConnId),
        ownerDeviceId: normalizeOptionalChatText(params.ownerDeviceId),
      });
      if (enqueued && !releaseWorkAdmission) {
        // Retain the session fence until this detached queued turn is adopted.
        releaseWorkAdmission = params.retainWorkAdmission();
      }
      if (enqueued) {
        lateFollowup.recordQueued();
      }
      return enqueued;
    },
    onCancellationRetired: () => {
      retireQueuedChatTurnCancellation(params.chatQueuedTurns, params.runId, params.controller);
    },
    onSettled: () => {
      completeQueuedChatTurn(params.chatQueuedTurns, params.runId, params.controller);
      releaseWorkAdmission?.();
      releaseWorkAdmission = undefined;
    },
  };
  return {
    lifecycle,
    isEnqueued: () => enqueued,
    onQueueDisposition: (reason) => {
      params.context.logGateway.info("chat queue turn intentionally skipped", {
        runId: params.runId,
        sessionKey: params.sessionKey,
        outcome: "skipped",
        reason,
      });
    },
    onQueuedFollowupReplyBatch: lateFollowup.deliver,
  };
}
