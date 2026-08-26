/** Stable cron run-history wire shape and legacy JSONL migration input. */
import type { FailoverReason } from "../agents/failover/signal.js";
import type {
  CronCompletionStatus,
  CronDeliveryStatus,
  CronDeliveryTrace,
  CronFailureNotificationDelivery,
  CronRunDiagnostics,
  CronRunStatus,
  CronRunTelemetry,
} from "./types.js";

/** Run-history record for a completed cron job execution. */
export type CronRunLogEntry = {
  ts: number;
  jobId: string;
  action: "finished";
  status?: CronRunStatus;
  completionStatus?: CronCompletionStatus;
  error?: string;
  errorReason?: FailoverReason;
  summary?: string;
  diagnostics?: CronRunDiagnostics;
  delivered?: boolean;
  deliveryStatus?: CronDeliveryStatus;
  deliveryError?: string;
  failureNotificationDelivery?: CronFailureNotificationDelivery;
  delivery?: CronDeliveryTrace;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
  triggerFired?: boolean;
} & CronRunTelemetry;
