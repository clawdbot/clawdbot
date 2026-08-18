// Qa Lab plugin module defines shared suite errors.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

export function toQaError(value: unknown): Error {
  return value instanceof Error ? value : new Error(formatErrorMessage(value));
}

type QaSuiteArtifactErrorCode =
  | "evidence_missing"
  | "report_missing"
  | "summary_missing"
  | "summary_read_failed"
  | "summary_parse_failed"
  | "summary_counts_invalid"
  | "summary_failure_count_missing"
  | "summary_blocking_count_missing";

export class QaSuiteArtifactError extends Error {
  readonly code: QaSuiteArtifactErrorCode;

  constructor(code: QaSuiteArtifactErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "QaSuiteArtifactError";
    this.code = code;
  }
}

type QaSuiteInfraErrorCode =
  | "agent_wait_failed"
  | "gateway_startup_unhealthy"
  | "gateway_ready_timeout"
  | "qa_cli_timeout"
  | "transport_ready_timeout";

export class QaSuiteInfraError extends Error {
  readonly code: QaSuiteInfraErrorCode;

  constructor(code: QaSuiteInfraErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "QaSuiteInfraError";
    this.code = code;
  }
}

export class QaSuiteScenarioSkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QaSuiteScenarioSkipError";
  }
}
