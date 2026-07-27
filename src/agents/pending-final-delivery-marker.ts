/** Persists restart-recoverable final delivery markers for agent runs. */
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import {
  buildRecoverablePendingFinalDeliveryText,
  normalizePendingFinalDeliveryPayloads,
  normalizePendingFinalRecoveryPayloads,
} from "../auto-reply/reply/pending-final-delivery.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import type { DeliveryContext } from "../utils/delivery-context.shared.js";
import { persistSessionEntry } from "./command/attempt-execution.shared.js";

type PersistPendingFinalDeliveryMarkerParams = {
  deliver: boolean;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  storePath: string;
  suppressVisibleSessionEffects: boolean;
  sessionReboundDuringRun: boolean;
  payloads: ReplyPayload[];
  deliveryContext?: DeliveryContext;
  runOwnedSessionId: string;
};

type PendingFinalDeliveryMarkerResult = {
  sessionEntry?: SessionEntry;
  pendingFinalDeliveryTextForThisRun?: string;
  pendingFinalDeliveryMarkerPersisted: boolean;
  hasSendableFinalPayload: boolean;
};

export async function persistPendingFinalDeliveryMarker(
  params: PersistPendingFinalDeliveryMarkerParams,
): Promise<PendingFinalDeliveryMarkerResult> {
  const recoveryPayloads = normalizePendingFinalRecoveryPayloads(params.payloads);
  const hasSendableFinalPayload = normalizePendingFinalDeliveryPayloads(params.payloads).length > 0;
  const recoverableText = buildRecoverablePendingFinalDeliveryText(recoveryPayloads);

  if (
    !params.deliver ||
    !params.sessionStore ||
    !params.sessionKey ||
    params.suppressVisibleSessionEffects ||
    params.sessionReboundDuringRun ||
    params.payloads.length === 0 ||
    isSubagentSessionKey(params.sessionKey) ||
    !recoverableText ||
    !hasSendableFinalPayload
  ) {
    return {
      sessionEntry: params.sessionEntry,
      pendingFinalDeliveryMarkerPersisted: false,
      hasSendableFinalPayload,
    };
  }

  const entry = params.sessionStore[params.sessionKey] ?? params.sessionEntry;
  if (!entry) {
    return {
      sessionEntry: params.sessionEntry,
      pendingFinalDeliveryMarkerPersisted: false,
      hasSendableFinalPayload,
    };
  }

  const now = Date.now();
  const persisted = await persistSessionEntry({
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    initialEntry: entry,
    entry: {
      ...entry,
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: recoverableText,
      pendingFinalDeliveryContext: params.deliveryContext,
      pendingFinalDeliveryCreatedAt: now,
      updatedAt: now,
    },
    shouldPersist: (current) =>
      current?.sessionId === params.runOwnedSessionId && current.abortedLastRun !== true,
  });
  const markerPersisted =
    persisted?.pendingFinalDelivery === true &&
    persisted.pendingFinalDeliveryText === recoverableText;

  return {
    sessionEntry: persisted,
    pendingFinalDeliveryTextForThisRun: markerPersisted ? recoverableText : undefined,
    pendingFinalDeliveryMarkerPersisted: markerPersisted,
    hasSendableFinalPayload,
  };
}
