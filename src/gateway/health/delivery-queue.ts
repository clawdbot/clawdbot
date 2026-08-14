import {
  countChannelIngressQueuePressure,
  countFailedChannelIngressQueueEntries,
} from "../../channels/message/ingress-queue-health.js";
import { getDeliveryFailureMaintenanceHealth } from "../../infra/delivery-queue-failure-maintenance.js";
import { summarizeDeliveryFailureQueues } from "../../infra/delivery-queue-failure-summary.js";
import { isDiagnosticFlagEnabled } from "../../infra/diagnostic-flags.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { HealthSummary } from "./types.js";

type DeliveryQueueHealthSummary = NonNullable<HealthSummary["deliveryQueues"]>;

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

/** Builds redacted inbound pressure and terminal delivery-failure health. */
export function buildDeliveryQueueHealthSummary(
  cachedIngressPressure?: ReturnType<typeof countChannelIngressQueuePressure>,
): DeliveryQueueHealthSummary | undefined {
  // Queue health reads are diagnostic; a storage failure must not take the
  // gateway health endpoint down with it.
  const failed: DeliveryQueueHealthSummary["failed"] = readQueueHealth(
    "outbound delivery queue health read failed",
    summarizeDeliveryFailureQueues,
  ).map((queue) => {
    const entry: DeliveryQueueHealthSummary["failed"][number] = {
      queueName: queue.queueName,
      count: queue.count,
      full: queue.full,
      compacted: queue.compacted,
      safe: queue.safe,
      ambiguous: queue.ambiguous,
      ownerManaged: queue.ownerManaged,
      ownerCleanupPending: queue.ownerCleanupPending,
      fenceNone: queue.fenceNone,
      fencePermanent: queue.fencePermanent,
      fenceProducerBounded: queue.fenceProducerBounded,
      legacyUnknown: queue.legacyUnknown,
      payloadBearing: queue.payloadBearing,
    };
    if (queue.oldestFailedAt != null) {
      entry.oldestFailedAt = queue.oldestFailedAt;
    }
    if (queue.oldestPayloadFailedAt != null) {
      entry.oldestPayloadFailedAt = queue.oldestPayloadFailedAt;
    }
    return entry;
  });
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
  const maintenance = getDeliveryFailureMaintenanceHealth();

  if (
    failed.length === 0 &&
    ingressFailed.length === 0 &&
    ingressPressure.length === 0 &&
    maintenance.errors === 0
  ) {
    return undefined;
  }
  return {
    failed,
    ...(ingressFailed.length > 0 ? { ingressFailed } : {}),
    ...(ingressPressure.length > 0 ? { ingressPressure } : {}),
    ...(maintenance.runAt > 0 || maintenance.errors > 0
      ? { maintenance: { lastRunAt: maintenance.runAt, errors: maintenance.errors } }
      : {}),
  };
}
