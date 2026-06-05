/** Shared cron run-log entry shape for SQLite and legacy JSONL stores. */
import type { FailoverReason } from "../agents/embedded-agent-helpers/types.js";
import type {
  CronDeliveryStatus,
  CronDeliveryTrace,
  CronFailureNotificationDelivery,
  CronRunDiagnostics,
  CronRunStatus,
  CronRunTelemetry,
} from "./types.js";

/** Append-only run-log record for a completed cron job execution. */
export type CronRunLogEntry = {
  ts: number;
  jobId: string;
  action: "finished";
  status?: CronRunStatus;
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
} & CronRunTelemetry;
