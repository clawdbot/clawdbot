/** Resolves create-time default delivery for new cron jobs. */
import type { CronDelivery, CronJobCreate } from "../types.js";

/** Resolves default cron delivery for new jobs when callers omit explicit delivery config. */
export function resolveInitialCronDelivery(input: CronJobCreate): CronDelivery | undefined {
  if (input.delivery) {
    return input.delivery;
  }
  if (
    input.sessionTarget === "isolated" &&
    (input.payload.kind === "agentTurn" || input.payload.kind === "command")
  ) {
    return { mode: "announce" };
  }
  return undefined;
}
