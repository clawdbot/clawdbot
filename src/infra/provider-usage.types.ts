export type UsageWindow = {
  label: string;
  usedPercent: number;
  resetAt?: number;
};

export type ProviderUsageSnapshot = {
  provider: UsageProviderId;
  displayName: string;
  windows: UsageWindow[];
  summary?: string;
  plan?: string;
  error?: string;
};

export type UsageSummary = {
  updatedAt: number;
  providers: ProviderUsageSnapshot[];
};

export type UsageProviderId =
  | "anthropic"
  | "deepseek"
  | "github-copilot"
  | "google-gemini-cli"
  | "minimax"
  | "openai"
  | "xiaomi"
  | "xiaomi-token-plan"
  | "zai";
