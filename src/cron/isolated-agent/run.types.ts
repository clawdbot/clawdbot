/** Result types returned by isolated cron agent runs. */
import type { CronDeliveryTrace, CronRunOutcome, CronRunTelemetry } from "../types.js";

/** Final isolated cron turn result merged into service state and run logs. */
export type RunCronAgentTurnResult = {
  /** Last non-empty agent text output (not truncated). */
  outputText?: string;
  /**
   * `true` when the isolated runner already handled the run's user-visible
   * delivery outcome, either through runner fallback delivery, explicit
   * suppression, or a matching message-tool send that already reached the
   * target.
   */
  delivered?: boolean;
  /**
   * `true` when cron attempted announce/direct delivery for this run.
   * This is tracked separately from `delivered` because some announce paths
   * cannot guarantee a final delivery ack synchronously.
   */
  deliveryAttempted?: boolean;
  /** Post-run delivery failure on an otherwise successful isolated turn. */
  deliveryError?: string;
  delivery?: CronDeliveryTrace;
} & CronRunOutcome &
  CronRunTelemetry;
