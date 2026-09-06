/** Privacy-safe provider allowance facts retained by the provider-usage cache. */
export type ProviderUsageMetricsRefreshOutcome =
  | "success"
  | "timeout"
  | "auth"
  | "rate_limit"
  | "billing"
  | "format"
  | "unknown";

type ProviderUsageMetricsWindow = Readonly<{
  window: string;
  usedRatio: number;
  resetTimestampSeconds?: number;
}>;

export type ProviderUsageMetricsProvider = Readonly<{
  provider: string;
  windows: readonly ProviderUsageMetricsWindow[];
  lastAttemptTimestampSeconds?: number;
  lastSuccessTimestampSeconds?: number;
  refreshSuccess: boolean;
  refreshOutcome: ProviderUsageMetricsRefreshOutcome;
}>;

export type ProviderUsageMetricsSnapshot = Readonly<{
  /** Process-local selection generation; never exported as a Prometheus label. */
  generation: number;
  providers: readonly ProviderUsageMetricsProvider[];
}>;

export type ProviderUsageMetricsListener = (snapshot: ProviderUsageMetricsSnapshot) => void;
