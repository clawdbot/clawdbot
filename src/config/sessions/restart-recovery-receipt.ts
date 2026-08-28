import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  hasActiveRestartRecoverySourceClaim,
  hasRestartRecoveryTerminalRun,
} from "./restart-recovery-state.js";
import { loadSessionEntry, updateSessionEntry } from "./session-accessor.js";
import type { SessionEntry } from "./types.js";

export type RestartRecoveryTerminalDeliveryScope = {
  sessionId: string;
  sessionKey: string;
  sourceTurnId: string;
  storePath: string;
  toolCallId: string;
};

type RestartRecoveryTerminalDeliveryDisposition =
  | "startable"
  | "already-delivered"
  | "delivery-ambiguous"
  | "stale"
  | "not-applicable";

function hasActiveClaim(
  entry: SessionEntry,
  scope: Pick<RestartRecoveryTerminalDeliveryScope, "sessionId" | "sourceTurnId">,
): boolean {
  return (
    entry.sessionId === scope.sessionId &&
    hasActiveRestartRecoverySourceClaim(entry, scope.sourceTurnId)
  );
}

function hasExactDeliveryClaim(
  entry: SessionEntry,
  scope: RestartRecoveryTerminalDeliveryScope,
): boolean {
  return (
    hasActiveClaim(entry, scope) && entry.restartRecoveryDeliveryToolCallId === scope.toolCallId
  );
}

function hasClaimlessLiveDeliveryState(
  entry: SessionEntry,
  scope: Pick<RestartRecoveryTerminalDeliveryScope, "sessionId">,
): boolean {
  return (
    entry.sessionId === scope.sessionId &&
    normalizeOptionalString(entry.restartRecoveryDeliveryRunId) === undefined &&
    normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) === undefined &&
    entry.restartRecoveryDeliveryReceiptState === undefined &&
    normalizeOptionalString(entry.restartRecoveryDeliveryToolCallId) === undefined
  );
}

/**
 * Pure decision mirror of `beginRestartRecoveryTerminalDelivery`: the
 * disposition a terminal source-reply send on `scope.sourceTurnId` resolves
 * to against the given session entry. The send path and the steering fence
 * classify every entry through this single decision surface so they can
 * never drift apart.
 */
function resolveRestartRecoveryTerminalDeliveryDisposition(
  entry: SessionEntry | null | undefined,
  scope: Pick<RestartRecoveryTerminalDeliveryScope, "sessionId" | "sourceTurnId">,
): RestartRecoveryTerminalDeliveryDisposition {
  if (entry) {
    if (
      entry.sessionId === scope.sessionId &&
      hasRestartRecoveryTerminalRun(entry, scope.sourceTurnId)
    ) {
      // The source turn already completed a terminal send.
      return "already-delivered";
    }
    if (entry.sessionId === scope.sessionId && hasClaimlessLiveDeliveryState(entry, scope)) {
      // No durable claim was ever armed for this turn.
      return "not-applicable";
    }
  }
  if (!entry || entry.sessionId !== scope.sessionId || !hasActiveClaim(entry, scope)) {
    return "stale";
  }
  if (entry.restartRecoveryDeliveryReceiptState || entry.restartRecoveryDeliveryToolCallId) {
    return entry.restartRecoveryDeliveryReceiptState === "delivered-terminal"
      ? "already-delivered"
      : "delivery-ambiguous";
  }
  return "startable";
}

/**
 * True when the session's active run can no longer own another terminal
 * source-reply send: it already holds a delivery receipt (terminal-pending or
 * delivered-terminal), an unresolved terminal tool-call id, a terminal-source
 * tombstone for the exact active source turn after claim cleanup, or a stale
 * claim. This is the fail-closed classification of
 * `beginRestartRecoveryTerminalDelivery` (already-delivered /
 * delivery-ambiguous / stale) narrowed to the entry the fence can observe, so
 * steering never accepts an inbound into a turn whose terminal send would be
 * refused. Callers must supply the active source-turn identity: terminal run
 * ids are accumulated session history, so a tombstone may only fail-close the
 * fence when it belongs to the target source turn itself.
 */
export function isRestartRecoveryTerminalDeliveryFailClosed(
  entry: SessionEntry | null | undefined,
  sessionId: string,
  sourceTurnId: string,
): boolean {
  if (!entry) {
    // No session entry means no persisted receipt state to fence; the send
    // path arms a fresh claim on the same entry surface.
    return false;
  }
  if (entry.restartRecoveryDeliveryReceiptState || entry.restartRecoveryDeliveryToolCallId) {
    return true;
  }
  const normalizedSourceTurnId = normalizeOptionalString(sourceTurnId) ?? "";
  const disposition = resolveRestartRecoveryTerminalDeliveryDisposition(entry, {
    sessionId,
    sourceTurnId: normalizedSourceTurnId,
  });
  if (disposition === "not-applicable") {
    // Claimless entries are the legitimate fresh state ("not-applicable" in
    // beginRestartRecoveryTerminalDelivery); a tombstone only fail-closes the
    // fence when it records this exact source turn, not any earlier one.
    return hasRestartRecoveryTerminalRun(entry, normalizedSourceTurnId);
  }
  return (
    disposition === "already-delivered" ||
    disposition === "delivery-ambiguous" ||
    disposition === "stale"
  );
}

function loadCurrent(scope: RestartRecoveryTerminalDeliveryScope): SessionEntry | undefined {
  return loadSessionEntry({
    sessionKey: scope.sessionKey,
    storePath: scope.storePath,
    readConsistency: "latest",
  });
}

/**
 * Persists ambiguity before a terminal external send is allowed to start.
 * Arms the receipt only when the full disposition is "startable", so the
 * fail-closed classification stays shared with the steering fence.
 */
export async function beginRestartRecoveryTerminalDelivery(
  scope: RestartRecoveryTerminalDeliveryScope,
): Promise<"started" | "already-delivered" | "delivery-ambiguous" | "stale" | "not-applicable"> {
  let started = false;
  const updated = await updateSessionEntry(
    { sessionKey: scope.sessionKey, storePath: scope.storePath },
    (entry) => {
      if (resolveRestartRecoveryTerminalDeliveryDisposition(entry, scope) !== "startable") {
        return null;
      }
      started = true;
      return {
        restartRecoveryDeliveryReceiptState: "terminal-pending",
        restartRecoveryDeliveryToolCallId: scope.toolCallId,
        updatedAt: Date.now(),
      };
    },
    { skipMaintenance: true, takeCacheOwnership: true },
  );
  if (
    started &&
    updated !== null &&
    hasExactDeliveryClaim(updated, scope) &&
    updated.restartRecoveryDeliveryReceiptState === "terminal-pending"
  ) {
    return "started";
  }
  const current = loadCurrent(scope);
  const disposition = resolveRestartRecoveryTerminalDeliveryDisposition(current, scope);
  if (disposition === "startable") {
    throw new Error("failed to persist terminal delivery intent");
  }
  if (disposition === "not-applicable") {
    return "not-applicable";
  }
  // already-delivered | delivery-ambiguous | stale
  return disposition;
}

/** Resolves a pre-send ambiguity only after the provider confirms delivery. */
export async function completeRestartRecoveryTerminalDelivery(
  scope: RestartRecoveryTerminalDeliveryScope,
): Promise<"recorded" | "stale"> {
  const updated = await updateSessionEntry(
    { sessionKey: scope.sessionKey, storePath: scope.storePath },
    (entry) => {
      if (
        !hasExactDeliveryClaim(entry, scope) ||
        entry.restartRecoveryDeliveryReceiptState !== "terminal-pending"
      ) {
        return null;
      }
      return {
        restartRecoveryDeliveryReceiptState: "delivered-terminal",
        updatedAt: Date.now(),
      };
    },
    { skipMaintenance: true, takeCacheOwnership: true },
  );
  if (
    updated !== null &&
    hasExactDeliveryClaim(updated, scope) &&
    updated.restartRecoveryDeliveryReceiptState === "delivered-terminal"
  ) {
    return "recorded";
  }
  const current = loadCurrent(scope);
  if (!current || !hasActiveClaim(current, scope)) {
    return "stale";
  }
  if (
    hasExactDeliveryClaim(current, scope) &&
    current.restartRecoveryDeliveryReceiptState === "delivered-terminal"
  ) {
    return "recorded";
  }
  throw new Error("failed to persist terminal delivery completion");
}

/** Clears the pre-send intent only when the provider proves no delivery occurred. */
export async function cancelRestartRecoveryTerminalDelivery(
  scope: RestartRecoveryTerminalDeliveryScope,
): Promise<"cleared" | "stale"> {
  const updated = await updateSessionEntry(
    { sessionKey: scope.sessionKey, storePath: scope.storePath },
    (entry) => {
      if (
        !hasExactDeliveryClaim(entry, scope) ||
        entry.restartRecoveryDeliveryReceiptState !== "terminal-pending"
      ) {
        return null;
      }
      return {
        restartRecoveryDeliveryReceiptState: undefined,
        restartRecoveryDeliveryToolCallId: undefined,
        updatedAt: Date.now(),
      };
    },
    { skipMaintenance: true, takeCacheOwnership: true },
  );
  if (
    updated !== null &&
    hasActiveClaim(updated, scope) &&
    !updated.restartRecoveryDeliveryReceiptState &&
    !updated.restartRecoveryDeliveryToolCallId
  ) {
    return "cleared";
  }
  const current = loadCurrent(scope);
  if (!current || !hasActiveClaim(current, scope)) {
    return "stale";
  }
  if (!current.restartRecoveryDeliveryReceiptState && !current.restartRecoveryDeliveryToolCallId) {
    return "cleared";
  }
  if (
    hasExactDeliveryClaim(current, scope) &&
    current.restartRecoveryDeliveryReceiptState === "delivered-terminal"
  ) {
    return "stale";
  }
  throw new Error("failed to clear terminal delivery intent");
}
