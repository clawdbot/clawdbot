import type { SessionEntry } from "../config/sessions/types.js";
import {
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";

export function shouldPersistCurrentRunSessionCleanup(
  current: SessionEntry | undefined,
  sessionId: string,
): boolean {
  return (
    current !== undefined && current.sessionId === sessionId && current.abortedLastRun !== true
  );
}

export function shouldPersistRestartRecoveryContextClaim(
  current: SessionEntry | undefined,
  sessionId: string,
  runId: string,
  allowCreate: boolean,
): boolean {
  if (!current) {
    return allowCreate;
  }
  if (!shouldPersistCurrentRunSessionCleanup(current, sessionId)) {
    return false;
  }
  return (
    current.restartRecoveryDeliveryRunId === undefined ||
    current.restartRecoveryDeliveryRunId === runId
  );
}

export function shouldPersistRestartRecoveryCleanup(
  current: SessionEntry | undefined,
  sessionId: string,
  runId: string,
): boolean {
  return (
    shouldPersistCurrentRunSessionCleanup(current, sessionId) &&
    current?.restartRecoveryDeliveryRunId === runId
  );
}

export function buildCurrentRunRestartRecoveryClaim(params: {
  deliveryContext?: DeliveryContext;
  entry: SessionEntry;
  runId: string;
}): Pick<
  SessionEntry,
  | "restartRecoveryDeliveryContext"
  | "restartRecoveryDeliveryRunId"
  | "restartRecoveryDeliverySourceRunId"
> {
  // Recovery can preclaim a suppressed run by id without a delivery route.
  const adoptsTranscriptOnlyClaim =
    params.deliveryContext === undefined &&
    normalizeDeliveryContext(params.entry.restartRecoveryDeliveryContext) === undefined &&
    params.entry.restartRecoveryDeliveryRunId === params.runId;
  return {
    restartRecoveryDeliveryContext: params.deliveryContext,
    restartRecoveryDeliveryRunId:
      params.deliveryContext || adoptsTranscriptOnlyClaim ? params.runId : undefined,
    restartRecoveryDeliverySourceRunId: adoptsTranscriptOnlyClaim
      ? params.entry.restartRecoveryDeliverySourceRunId
      : undefined,
  };
}
