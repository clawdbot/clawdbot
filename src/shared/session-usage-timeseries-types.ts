/** Usage totals for one sampled point in a session usage time series. */
export type SessionUsageTimePoint = {
  /** Unix epoch milliseconds for the sample. */
  timestamp: number;
  /** Input tokens counted in this sample window. */
  input: number;
  /** Output tokens counted in this sample window. */
  output: number;
  /** Cached input tokens read in this sample window. */
  cacheRead: number;
  /** Cached input tokens written in this sample window. */
  cacheWrite: number;
  /** Total billable and cached tokens counted in this sample window. */
  totalTokens: number;
  /** Estimated cost for this sample window. */
  cost: number;
  /** Running token total through this sample. */
  cumulativeTokens: number;
  /** Running cost total through this sample. */
  cumulativeCost: number;
};

/** Downsampled usage series returned for a single session when requested. */
export type SessionUsageTimeSeries = {
  /** Session id for the series when loaded from a known session record. */
  sessionId?: string;
  /** Ordered samples for charting usage over time. */
  points: SessionUsageTimePoint[];
};
