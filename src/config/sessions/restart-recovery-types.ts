import type { DeliveryContext } from "../../utils/delivery-context.types.js";

/** Durable ownership and idempotency state for gateway restart recovery. */
export type SessionRestartRecoveryState = {
  restartRecoveryDeliveryContext?: DeliveryContext;
  restartRecoveryDeliveryRequestFingerprint?: string;
  restartRecoveryDeliveryRunId?: string;
  restartRecoveryDeliverySourceRunId?: string;
  restartRecoveryTerminalRunIds?: string[];
};
