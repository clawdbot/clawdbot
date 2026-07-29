/** One quota window reported by a provider usage endpoint. */
export type UsageWindow = {
  label: string;
  usedPercent: number;
  resetAt?: number;
};

/** Provider-reported monetary or credit facts. Units may be ISO currencies or provider credits. */
export type ProviderUsageBilling =
  | {
      type: "balance";
      label?: string;
      amount: number;
      unit: string;
    }
  | {
      type: "spend";
      label?: string;
      amount: number;
      unit: string;
      period?: string;
      resetAt?: number;
    }
  | {
      type: "budget";
      label?: string;
      used: number;
      limit: number;
      unit: string;
      period?: string;
      resetAt?: number;
    };

/** Provider-reported daily cost and token totals. Costs are actual provider billing, not estimates. */
export type ProviderUsageCostDaily = {
  date: string;
  amount: number;
  requests?: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
};

/** Aggregate model activity for the provider history window. */
export type ProviderUsageModelBreakdown = {
  name: string;
  requests?: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
};

/** Aggregate provider billing category for the history window. */
export type ProviderUsageCostBreakdown = {
  name: string;
  amount: number;
};

/** Provider-reported cost history and attribution for one bounded UTC window. */
export type ProviderUsageCostHistory = {
  unit: string;
  periodDays: number;
  scope?: string;
  daily: ProviderUsageCostDaily[];
  models: ProviderUsageModelBreakdown[];
  categories: ProviderUsageCostBreakdown[];
};

export type ProviderUsageSnapshot = {
  provider: UsageProviderId;
  displayName: string;
  windows: UsageWindow[];
  billing?: ProviderUsageBilling[];
  costHistory?: ProviderUsageCostHistory;
  summary?: string;
  plan?: string;
  /** Account identity (email) the usage was fetched under, when known. */
  accountEmail?: string;
  error?: string;
};

export type UsageSummary = {
  updatedAt: number;
  providers: ProviderUsageSnapshot[];
};

/** Normalized provider id. Usage providers are discovered from plugin hooks at runtime. */
export type UsageProviderId = string;
