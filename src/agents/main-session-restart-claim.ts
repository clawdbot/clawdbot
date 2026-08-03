import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";

export type ExpectedRestartRecoveryClaim = {
  canonicalSessionKey?: string;
  recoveryRunId: string;
  recoverySourceRunId: string;
  sessionId: string;
  sessionKey: string;
};

function matchesExpectedRestartRecoveryClaim(
  entry: SessionEntry | undefined,
  expected: ExpectedRestartRecoveryClaim,
): entry is SessionEntry {
  return Boolean(
    entry &&
    entry.sessionId === expected.sessionId &&
    entry.status === "running" &&
    entry.abortedLastRun === true &&
    normalizeOptionalString(entry.restartRecoveryDeliveryRunId) === expected.recoveryRunId &&
    normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) ===
      expected.recoverySourceRunId,
  );
}

export function loadExpectedRestartRecoveryClaim(params: {
  expected: ExpectedRestartRecoveryClaim;
  storePath: string;
}): SessionEntry | undefined {
  const exact = loadExactSessionEntry({
    readConsistency: "latest",
    sessionKey: params.expected.sessionKey,
    storePath: params.storePath,
  });
  return exact?.sessionKey === params.expected.sessionKey &&
    matchesExpectedRestartRecoveryClaim(exact.entry, params.expected)
    ? exact.entry
    : undefined;
}

export function buildUnresumableSessionNoticeIdempotencyKey(entry: SessionEntry): string {
  const interruptedRunId =
    normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) ??
    normalizeOptionalString(entry.restartRecoveryDeliveryRunId) ??
    entry.sessionId;
  return `main-session-restart-recovery:${interruptedRunId}:failed-notice`;
}
