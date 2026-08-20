import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  readSessionPlacementRecovery,
  type SessionPlacementRecovery,
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
  | { status: "send-rejected"; error: string; messageId: string }
  | { status: "cleanup-rejected"; error: string; messageId?: string }
  | { status: "dispatch-rejected"; error: string }
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
  setRecoveryPhase: (phase: SessionPlacementRecovery["phase"], durable: boolean) => void;
}): Promise<SessionPlacementDraftAdvanceResult> {
  const persistRecovery = params.persistRecovery !== false;
  const recovery = params.recovery;
  // Dispatch and send require both fences. After accepted delivery, inspect
  // them separately so lifecycle interruption is not reported as takeover.
  const isCurrentOwner = () => params.isLifecycleCurrent() && params.ownsRecovery();
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
        ? existingRecovery?.sessionKey === recovery.sessionKey
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
      ? existingRecovery?.sessionKey === recovery.sessionKey
      : writeSessionPlacementRecovery(recovery)
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
      retryTerminalPlacement: params.recovering && recovery.phase === "sending",
      cleanupOnCancellation: params.cleanupOnCancellation,
    },
    isCurrentOwner,
    () => {
      if (recovery.phase === "sending") {
        return true;
      }
      if (!persistRecovery) {
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
    return placementStart;
  }
  if (placementStart.status === "send-not-started") {
    params.clearRecovery("resolved");
    return { status: "dispatch-rejected", error: placementStart.error };
  }
  if (placementStart.status === "send-definitive-rejected") {
    params.clearRecovery("resolved");
    return { status: "dispatch-rejected", error: placementStart.error };
  }
  if (placementStart.status === "session-missing") {
    params.clearRecovery("resolved");
    return { status: "dispatch-rejected", error: placementStart.error };
  }
  if (placementStart.status === "dispatch-rejected") {
    // The created session is already the visible recovery surface. Dispatch
    // owns worker cleanup; retain the session so a definitive failure cannot
    // turn immediate navigation into a dead route.
    params.clearRecovery("resolved");
    return {
      status: "dispatch-rejected",
      error: placementStart.error,
    };
  }
  if (placementStart.status === "send-rejected") {
    return placementStart;
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
