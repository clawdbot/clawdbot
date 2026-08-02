import { countFailedChannelIngressQueueEntries } from "../../channels/message/ingress-queue.js";
import { countFailedDeliveryQueueEntries } from "../../infra/delivery-queue-sqlite.js";
import { isDiagnosticFlagEnabled } from "../../infra/diagnostic-flags.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { DeliveryQueueHealthSummary } from "./types.js";

const healthLog = createSubsystemLogger("health");

const debugHealth = (message: string, error: unknown) => {
  if (isDiagnosticFlagEnabled("health")) {
    healthLog.info(message, { error: formatErrorMessage(error) });
  }
};

/** Builds dead-lettered inbound and outbound queue health for gateway snapshots. */
export function buildDeliveryQueueHealthSummary(): DeliveryQueueHealthSummary | undefined {
  // Queue health reads are diagnostic; a storage failure must not take the
  // gateway health endpoint down with it.
  let failed: DeliveryQueueHealthSummary["failed"] = [];
  try {
    failed = countFailedDeliveryQueueEntries().map((queue) => {
      const entry: DeliveryQueueHealthSummary["failed"][number] = {
        queueName: queue.queueName,
        count: queue.count,
      };
      if (queue.oldestFailedAt != null) {
        entry.oldestFailedAt = queue.oldestFailedAt;
      }
      return entry;
    });
  } catch (error) {
    debugHealth("outbound delivery queue health read failed", error);
  }

  let ingressFailed: NonNullable<DeliveryQueueHealthSummary["ingressFailed"]> = [];
  try {
    ingressFailed = countFailedChannelIngressQueueEntries().map((queue) => {
      const entry: NonNullable<DeliveryQueueHealthSummary["ingressFailed"]>[number] = {
        channelId: queue.channelId,
        accountId: queue.accountId,
        count: queue.count,
      };
      if (queue.oldestFailedAt != null) {
        entry.oldestFailedAt = queue.oldestFailedAt;
      }
      return entry;
    });
  } catch (error) {
    debugHealth("channel ingress queue health read failed", error);
  }

  if (failed.length === 0 && ingressFailed.length === 0) {
    return undefined;
  }
  return {
    failed,
    ...(ingressFailed.length > 0 ? { ingressFailed } : {}),
  };
}
