import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  readCloudSessionRecovery,
  type CloudSessionRecovery,
  writeCloudSessionRecovery,
  writeCloudSessionRecoveryIfAvailable,
} from "./cloud-recovery.ts";
import {
  deleteCloudDraftSession,
  deleteRecoveredCloudDraftSession,
  startCloudInitialTurn,
} from "./cloud-startup.ts";

export type CloudDraftAdvanceResult =
  | { status: "started"; messageId: string; messageSeq?: number }
  | { status: "send-rejected"; error: string; messageId: string }
  | { status: "cleanup-rejected"; error: string; messageId?: string }
  | { status: "dispatch-rejected"; error: string }
  | { status: "cancelled"; cleanupError?: string; recoveryPersisted: boolean }
  | { status: "interrupted" }
  | { status: "ownership-lost" };

type CloudRecoveryRetirement = "resolved" | "interrupted";

export async function advanceCloudDraftSession(params: {
  client: Pick<GatewayBrowserClient, "request">;
  recovery: CloudSessionRecovery;
  persistRecovery?: boolean;
  cleanupOnCancellation: boolean;
  recovering: boolean;
  isLifecycleCurrent: () => boolean;
  ownsRecovery: () => boolean;
  clearRecovery: (retirement: CloudRecoveryRetirement) => void;
  setRecoveryPhase: (phase: CloudSessionRecovery["phase"], durable: boolean) => void;
}): Promise<CloudDraftAdvanceResult> {
  const persistRecovery = params.persistRecovery !== false;
  const recovery = params.recovery;
  // Dispatch and send require both fences. After accepted delivery, inspect
  // them separately so lifecycle interruption is not reported as takeover.
  const isCurrentOwner = () => params.isLifecycleCurrent() && params.ownsRecovery();
  const existingRecovery =
    params.recovering && persistRecovery
      ? readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope, recovery.sessionKey)
      : null;
  if (!isCurrentOwner()) {
    if (!params.cleanupOnCancellation) {
      return { status: "interrupted" };
    }
    const recoveryPersisted = persistRecovery
      ? params.recovering
        ? existingRecovery?.sessionKey === recovery.sessionKey
        : writeCloudSessionRecoveryIfAvailable(recovery)
      : false;
    const cleanupError = params.recovering
      ? await deleteRecoveredCloudDraftSession(params.client, recovery.sessionKey, recovery.agentId)
      : await deleteCloudDraftSession(params.client, recovery.sessionKey, recovery.agentId);
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
      : writeCloudSessionRecovery(recovery)
    : true;
  if (!isCurrentOwner() || !recoveryPersisted) {
    if (!params.cleanupOnCancellation && !isCurrentOwner()) {
      return { status: "interrupted" };
    }
    if (params.recovering && !recoveryPersisted) {
      return {
        status: "cancelled",
        cleanupError: "cloud recovery storage is unavailable",
        recoveryPersisted: false,
      };
    }
    const cleanupError = params.recovering
      ? await deleteRecoveredCloudDraftSession(params.client, recovery.sessionKey, recovery.agentId)
      : await deleteCloudDraftSession(params.client, recovery.sessionKey, recovery.agentId);
    if (!cleanupError) {
      params.clearRecovery("resolved");
    }
    return { status: "cancelled", cleanupError, recoveryPersisted };
  }

  const cloudStart = await startCloudInitialTurn(
    params.client,
    {
      key: recovery.sessionKey,
      agentId: recovery.agentId,
      profileId: recovery.profileId,
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
      const currentRecovery = readCloudSessionRecovery(
        recovery.gatewayUrl,
        recovery.recoveryScope,
        recovery.sessionKey,
      );
      if (currentRecovery && currentRecovery.messageId !== recovery.messageId) {
        return false;
      }
      const persisted = writeCloudSessionRecovery({ ...recovery, phase: "sending" });
      if (persisted) {
        params.setRecoveryPhase("sending", true);
      }
      return persisted;
    },
  );
  if (!params.cleanupOnCancellation && !isCurrentOwner()) {
    return { status: "interrupted" };
  }
  if (cloudStart.status === "interrupted") {
    return cloudStart;
  }
  if (cloudStart.status === "cancelled") {
    const cleanupError = await deleteCloudDraftSession(
      params.client,
      recovery.sessionKey,
      recovery.agentId,
    );
    if (!cleanupError) {
      params.clearRecovery("resolved");
    }
    return { status: "cancelled", cleanupError, recoveryPersisted: persistRecovery };
  }
  if (cloudStart.status === "cleanup-rejected") {
    return cloudStart;
  }
  if (cloudStart.status === "send-not-started") {
    params.clearRecovery("resolved");
    return { status: "dispatch-rejected", error: cloudStart.error };
  }
  if (cloudStart.status === "send-definitive-rejected") {
    params.clearRecovery("resolved");
    return { status: "dispatch-rejected", error: cloudStart.error };
  }
  if (cloudStart.status === "session-missing") {
    params.clearRecovery("resolved");
    return { status: "dispatch-rejected", error: cloudStart.error };
  }
  if (cloudStart.status === "dispatch-rejected") {
    // The created session is already the visible recovery surface. Dispatch
    // owns worker cleanup; retain the session so a definitive failure cannot
    // turn immediate navigation into a dead route.
    params.clearRecovery("resolved");
    return {
      status: "dispatch-rejected",
      error: cloudStart.error,
    };
  }
  if (cloudStart.status === "send-rejected") {
    return cloudStart;
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
  return cloudStart;
}
