// Defines explicit consent for anonymous feature-usage statistics.

export type TelemetryConfig = {
  /** Shares anonymous feature counts with the daily update check when explicitly enabled. */
  enabled?: boolean;
  /** ISO timestamp recording when the operator accepted or declined feature statistics. */
  consentedAt?: string;
};
