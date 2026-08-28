import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { chatMessagesContainQueuedSend } from "../../pages/chat/chat-send-support.ts";
import { formatUiError } from "../format-error.ts";
import { isUiGlobalSessionKey } from "./session-key.ts";
import {
  pauseSessionPlacementRecovery,
  readSessionPlacementRecovery,
  type SessionPlacementRecovery,
  type SessionPlacementPausedRecovery,
  writeSessionPlacementRecovery,
  writeSessionPlacementRecoveryIfAvailable,
} from "./session-placement-recovery.ts";
import {
  deleteRecoveredSessionPlacementDraft,
  deleteSessionPlacementDraft,
  startSessionPlacementInitialTurn,
} from "./session-placement-startup.ts";

export type SessionPlacementDraftAdvanceResult =
  | { status: "started"; messageId: string; messageSeq?: number }
  | { status: "paused"; recovery: SessionPlacementPausedRecovery }
  | { status: "cancelled"; cleanupError?: string; recoveryPersisted: boolean }
  | { status: "interrupted" }
  | { status: "ownership-lost" };

type SessionPlacementRecoveryRetirement = "resolved" | "interrupted";

export async function advanceSessionPlacementDraft(params: {
  client: Pick<GatewayBrowserClient, "request">;
  recovery: SessionPlacementRecovery;
  persistRecovery?: boolean;
  cleanupOnCancellation: boolean;
  recovering: boolean;
  isLifecycleCurrent: () => boolean;
  ownsRecovery: () => boolean;
  clearRecovery: (retirement: SessionPlacementRecoveryRetirement) => void;
  setRecoveryPhase: (phase: "sending", durable: boolean) => void;
}): Promise<SessionPlacementDraftAdvanceResult> {
  const persistRecovery = params.persistRecovery !== false;
  const recovery = params.recovery;
  let reason: SessionPlacementPausedRecovery["reason"] = "not-sent";
  const pause = (error: string, next = reason): SessionPlacementDraftAdvanceResult => ({
    status: "paused",
    recovery: pauseSessionPlacementRecovery(recovery, error, persistRecovery, next),
  });
  // Dispatch and send require both fences. After accepted delivery, inspect
  // them separately so lifecycle interruption is not reported as takeover.
  const isCurrentOwner = () => params.isLifecycleCurrent() && params.ownsRecovery();
  if (
    recovery.phase === "sending" ||
    (recovery.phase === "paused" && recovery.reason === "unconfirmed")
  ) {
    // A send key is not universal restart-safe deduplication. Only an exact
    // authoritative user receipt can resolve uncertainty; absence proves nothing.
    if (!isCurrentOwner()) {
      return { status: "interrupted" };
    }
    const history = await params.client
      .request<{ messages?: unknown[] }>("chat.history", {
        sessionKey: recovery.sessionKey,
        ...(isUiGlobalSessionKey(recovery.sessionKey) ? { agentId: recovery.agentId } : {}),
        limit: 1000,
      })
      .catch((error: unknown) => ({ messages: [], error: formatUiError(error) }));
    if (!isCurrentOwner()) {
      return { status: "interrupted" };
    }
    if (
      chatMessagesContainQueuedSend(
        history.messages,
        {
          id: recovery.messageId,
          text: recovery.message,
          createdAt: Date.now(),
          sendRunId: recovery.messageId,
        },
        true,
      )
    ) {
      params.clearRecovery("resolved");
      return { status: "started", messageId: recovery.messageId };
    }
    return pause(
      "error" in history
        ? history.error
        : "No matching user message was found in the available history. Delivery remains unconfirmed.",
      "unconfirmed",
    );
  }
  if (recovery.phase === "paused") {
    return { status: "paused", recovery };
  }
  const existingRecovery =
    params.recovering && persistRecovery
      ? readSessionPlacementRecovery(
          recovery.gatewayUrl,
          recovery.recoveryScope,
          recovery.sessionKey,
        )
      : null;
  if (!isCurrentOwner()) {
    if (!params.cleanupOnCancellation) {
      return { status: "interrupted" };
    }
    const recoveryPersisted = persistRecovery
      ? params.recovering
        ? existingRecovery?.messageId === recovery.messageId
        : writeSessionPlacementRecoveryIfAvailable(recovery)
      : false;
    const cleanupError = params.recovering
      ? await deleteRecoveredSessionPlacementDraft(
          params.client,
          recovery.sessionKey,
          recovery.agentId,
        )
      : await deleteSessionPlacementDraft(params.client, recovery.sessionKey, recovery.agentId);
    if (!cleanupError) {
      params.clearRecovery("resolved");
    }
    return {
      status: "cancelled",
      cleanupError,
      recoveryPersisted: cleanupError ? recoveryPersisted : false,
    };
  }
  const recoveryPersisted = persistRecovery
    ? params.recovering
      ? existingRecovery?.messageId === recovery.messageId
      : writeSessionPlacementRecoveryIfAvailable(recovery)
    : true;
  if (!isCurrentOwner() || !recoveryPersisted) {
    if (!params.cleanupOnCancellation && !isCurrentOwner()) {
      return { status: "interrupted" };
    }
    if (params.recovering && !recoveryPersisted) {
      return {
        status: "cancelled",
        cleanupError: "placement recovery storage is unavailable",
        recoveryPersisted: false,
      };
    }
    const cleanupError = params.recovering
      ? await deleteRecoveredSessionPlacementDraft(
          params.client,
          recovery.sessionKey,
          recovery.agentId,
        )
      : await deleteSessionPlacementDraft(params.client, recovery.sessionKey, recovery.agentId);
    if (!cleanupError) {
      params.clearRecovery("resolved");
    }
    return { status: "cancelled", cleanupError, recoveryPersisted };
  }

  const placementStart = await startSessionPlacementInitialTurn(
    params.client,
    {
      key: recovery.sessionKey,
      agentId: recovery.agentId,
      target: recovery.target,
      message: recovery.message,
      attachments: recovery.attachments,
      messageId: recovery.messageId,
      recovering: params.recovering,
      cleanupOnCancellation: params.cleanupOnCancellation,
    },
    isCurrentOwner,
    () => {
      if (!persistRecovery) {
        reason = "unconfirmed";
        params.setRecoveryPhase("sending", false);
        return true;
      }
      const currentRecovery = readSessionPlacementRecovery(
        recovery.gatewayUrl,
        recovery.recoveryScope,
        recovery.sessionKey,
      );
      if (currentRecovery && currentRecovery.messageId !== recovery.messageId) {
        return false;
      }
      const persisted = writeSessionPlacementRecovery({ ...recovery, phase: "sending" });
      if (persisted) {
        reason = "unconfirmed";
        params.setRecoveryPhase("sending", true);
      }
      return persisted;
    },
  );
  if (!params.cleanupOnCancellation && !isCurrentOwner()) {
    return { status: "interrupted" };
  }
  if (placementStart.status === "interrupted") {
    return placementStart;
  }
  if (placementStart.status === "cancelled") {
    const cleanupError = await deleteSessionPlacementDraft(
      params.client,
      recovery.sessionKey,
      recovery.agentId,
    );
    if (!cleanupError) {
      params.clearRecovery("resolved");
    }
    return { status: "cancelled", cleanupError, recoveryPersisted: persistRecovery };
  }
  if (placementStart.status === "cleanup-rejected") {
    return pause(placementStart.error);
  }
  if (placementStart.status === "session-missing") {
    params.clearRecovery("resolved");
    return { status: "cancelled", recoveryPersisted: false };
  }
  if (placementStart.status === "send-not-started") {
    return pause(placementStart.error, "not-sent");
  }
  if (placementStart.status === "send-definitive-rejected") {
    return pause(placementStart.error, "rejected");
  }
  if (placementStart.status === "dispatch-rejected" || placementStart.status === "send-rejected") {
    return pause(placementStart.error);
  }
  if (!params.isLifecycleCurrent()) {
    // The page recorded why its lifecycle changed before this accepted send returned.
    // Retire the delivered recovery without relabeling that interruption as a takeover.
    params.clearRecovery("interrupted");
    return { status: "interrupted" };
  }
  if (!params.ownsRecovery()) {
    // Delivery completed, so retire only this submission's recovery record.
    // The callback's expected-key guard preserves any newer owner.
    params.clearRecovery("resolved");
    return { status: "ownership-lost" };
  }
  params.clearRecovery("resolved");
  return placementStart;
}
