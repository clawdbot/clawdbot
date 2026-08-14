import type { TurnAdoptionLifecycle } from "../../auto-reply/get-reply-options.types.js";
import {
  completeQueuedChatTurn,
  registerQueuedChatTurn,
  retireQueuedChatTurnCancellation,
  type QueuedChatTurnMap,
} from "../chat-queued-turns.js";
import { normalizeOptionalChatText } from "./chat-text-normalization.js";

export function createChatSendTurnAdoptionLifecycle(params: {
  chatQueuedTurns: QueuedChatTurnMap;
  runId: string;
  controller: AbortController;
  sessionId: string;
  sessionKey: string;
  agentId?: string;
  ownerConnId?: string;
  ownerDeviceId?: string;
  ownerKey?: string;
  originatingLeafEntryId?: string | null;
  hasCronCreatorAuthority: boolean;
  retainWorkAdmission: () => () => void;
}): { lifecycle: TurnAdoptionLifecycle; isEnqueued: () => boolean } {
  let enqueued = false;
  let releaseWorkAdmission: (() => void) | undefined;
  const lifecycle: TurnAdoptionLifecycle = {
    // Gateway cancel identity only — share collect key via ownerKey.
    admission: "cancel-only",
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
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        ownerConnId: normalizeOptionalChatText(params.ownerConnId),
        ownerDeviceId: normalizeOptionalChatText(params.ownerDeviceId),
      });
      if (enqueued && !releaseWorkAdmission) {
        // Retain the session fence until this detached queued turn is adopted.
        releaseWorkAdmission = params.retainWorkAdmission();
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
  return { lifecycle, isEnqueued: () => enqueued };
}
