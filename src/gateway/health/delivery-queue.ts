import {
  countChannelIngressQueuePressure,
  countFailedChannelIngressQueueEntries,
} from "../../channels/message/ingress-queue-health.js";
import { countFailedDeliveryQueueEntries } from "../../infra/delivery-queue-sqlite.js";
import { isDiagnosticFlagEnabled } from "../../infra/diagnostic-flags.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const healthLog = createSubsystemLogger("health");

const debugHealth = (message: string, error: unknown) => {
  if (isDiagnosticFlagEnabled("health")) {
    healthLog.info(message, { error: formatErrorMessage(error) });
  }
};

function readQueueHealth<T>(message: string, read: () => T[]): T[] {
  try {
    return read();
  } catch (error) {
    debugHealth(message, error);
    return [];
  }
}

/** Builds redacted inbound pressure and dead-letter health for gateway snapshots. */
export function buildDeliveryQueueHealthSummary(
  cachedIngressPressure?: ReturnType<typeof countChannelIngressQueuePressure>,
) {
  // Queue health reads are diagnostic; a storage failure must not take the
  // gateway health endpoint down with it.
  const failed = readQueueHealth(
    "outbound delivery queue health read failed",
    countFailedDeliveryQueueEntries,
  );
  const ingressFailed = readQueueHealth(
    "channel ingress failed queue health read failed",
    countFailedChannelIngressQueueEntries,
  );
  const ingressPressure =
    cachedIngressPressure ??
    readQueueHealth(
      "channel ingress pressure health read failed",
      countChannelIngressQueuePressure,
    );

  if (failed.length === 0 && ingressFailed.length === 0 && ingressPressure.length === 0) {
    return undefined;
  }
  return {
    failed,
    ...(ingressFailed.length > 0 ? { ingressFailed } : {}),
    ...(ingressPressure.length > 0 ? { ingressPressure } : {}),
  };
}
