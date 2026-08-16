/** Resolves create-time default delivery for new cron jobs. */
import { shouldDefaultCronDeliveryToAnnounce } from "../delivery-defaults.js";
import type { CronDelivery, CronJobCreate } from "../types.js";

/**
 * Resolves default cron delivery for new jobs when callers omit explicit delivery config.
 * This is the direct-service contract: supported creation paths (gateway `cron.add`,
 * agent cron tool) already fill delivery in `normalizeCronJobCreate`, so this default
 * only governs callers that reach `CronService.add`/declarative convergence directly.
 * The shared predicate keeps this contract consistent across write-time,
 * read-time, and service-bypass paths.
 */
export function resolveInitialCronDelivery(input: CronJobCreate): CronDelivery | undefined {
  if (input.delivery) {
    return input.delivery;
  }
  if (
    shouldDefaultCronDeliveryToAnnounce({
      payloadKind: input.payload.kind,
      sessionTarget: input.sessionTarget,
    })
  ) {
    return { mode: "announce" };
  }
  return undefined;
}
