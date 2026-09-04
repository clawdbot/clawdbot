import type { NormalizeReplySkipReason } from "../../auto-reply/reply/normalize-reply-skip-reason.js";
/** Result types returned by isolated cron agent runs. */
import type {
  CronDeliveryTrace,
  CronResolvedDeliveryState,
  CronNextCheckProposal,
  CronRunOutcome,
  CronRunTelemetry,
} from "../types.js";

/** Pre-run disposition returned when isolated cron work never enters an agent runner. */
export type CronAgentAdmissionDisposition = "session-conflict" | "rejected";

/** Final isolated cron turn result merged into service state and run logs. */
export type RunCronAgentTurnResult = {
  /** Typed pre-run rejection so callers never infer admission state from error prose. */
  admissionDisposition?: CronAgentAdmissionDisposition;
  /** Delivery fact authored by the dispatcher, separate from execution status. */
  deliveryState?: CronResolvedDeliveryState;
  /** Last non-empty agent text output (not truncated). */
  outputText?: string;
  /** Confirmed target delivery, including matching message-tool sends; unknown is omitted. */
  delivered?: boolean;
  /**
   * `true` when cron attempted announce/direct delivery for this run.
   * This is tracked separately from `delivered` because some announce paths
   * cannot guarantee a final delivery ack synchronously.
   */
  deliveryAttempted?: boolean;
  /** Post-run delivery failure on an otherwise successful isolated turn. */
  deliveryError?: string;
  /** Intentional direct-delivery non-outcome recorded before transport custody. */
  deliverySuppressionReason?: NormalizeReplySkipReason;
  delivery?: CronDeliveryTrace;
  nextCheck?: CronNextCheckProposal;
} & CronRunOutcome &
  CronRunTelemetry;
