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

function hasActiveClaim(entry: SessionEntry, scope: RestartRecoveryTerminalDeliveryScope): boolean {
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
  scope: RestartRecoveryTerminalDeliveryScope,
): boolean {
  return (
    entry.sessionId === scope.sessionId &&
    normalizeOptionalString(entry.restartRecoveryDeliveryRunId) === undefined &&
    normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) === undefined &&
    entry.restartRecoveryDeliveryReceiptState === undefined &&
    normalizeOptionalString(entry.restartRecoveryDeliveryToolCallId) === undefined
  );
}

function loadCurrent(scope: RestartRecoveryTerminalDeliveryScope): SessionEntry | undefined {
  return loadSessionEntry({
    sessionKey: scope.sessionKey,
    storePath: scope.storePath,
    readConsistency: "latest",
  });
}

/** Persists ambiguity before a terminal external send is allowed to start. */
export async function beginRestartRecoveryTerminalDelivery(
  scope: RestartRecoveryTerminalDeliveryScope,
): Promise<"started" | "blocked" | "stale" | "not-applicable"> {
  let started = false;
  const updated = await updateSessionEntry(
    { sessionKey: scope.sessionKey, storePath: scope.storePath },
    (entry) => {
      if (
        !hasActiveClaim(entry, scope) ||
        entry.restartRecoveryDeliveryReceiptState ||
        entry.restartRecoveryDeliveryToolCallId
      ) {
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
  // A terminal tombstone means the source already finished even though active claim fields are gone.
  if (
    current?.sessionId === scope.sessionId &&
    hasRestartRecoveryTerminalRun(current, scope.sourceTurnId)
  ) {
    return "blocked";
  }
  // The gateway already verified a short-lived current-turn capability. Room
  // events intentionally persist no running recovery state, so only durable
  // claim/receipt/tombstone fields can decide whether this live send is stale.
  if (current && hasClaimlessLiveDeliveryState(current, scope)) {
    return "not-applicable";
  }
  if (!current || !hasActiveClaim(current, scope)) {
    return "stale";
  }
  if (current.restartRecoveryDeliveryReceiptState || current.restartRecoveryDeliveryToolCallId) {
    return "blocked";
  }
  throw new Error("failed to persist terminal delivery intent");
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
