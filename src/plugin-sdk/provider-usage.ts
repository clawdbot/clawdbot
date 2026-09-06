// Public usage fetch helpers for provider plugins.

export type {
  ProviderUsageCostBreakdown,
  ProviderUsageCostDaily,
  ProviderUsageCostHistory,
  ProviderUsageModelBreakdown,
  ProviderUsageBilling,
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageWindow,
} from "../infra/provider-usage.types.js";

// Registration uses the pure auth/format helpers below. Provider request code loads
// only on fetch; the shared HTTP owner still bounds requests and response bodies.
export const fetchClaudeUsage: typeof import("../infra/provider-usage.fetch.claude.js").fetchClaudeUsage =
  async (...args) =>
    (await import("../infra/provider-usage.fetch.claude.js")).fetchClaudeUsage(...args);
export const fetchCodexUsage: typeof import("../infra/provider-usage.fetch.codex.js").fetchCodexUsage =
  async (...args) =>
    (await import("../infra/provider-usage.fetch.codex.js")).fetchCodexUsage(...args);
export const fetchDeepSeekUsage: typeof import("../infra/provider-usage.fetch.deepseek.js").fetchDeepSeekUsage =
  async (...args) =>
    (await import("../infra/provider-usage.fetch.deepseek.js")).fetchDeepSeekUsage(...args);
export const fetchGeminiUsage: typeof import("../infra/provider-usage.fetch.gemini.js").fetchGeminiUsage =
  async (...args) =>
    (await import("../infra/provider-usage.fetch.gemini.js")).fetchGeminiUsage(...args);
export const fetchMinimaxUsage: typeof import("../infra/provider-usage.fetch.minimax.js").fetchMinimaxUsage =
  async (...args) =>
    (await import("../infra/provider-usage.fetch.minimax.js")).fetchMinimaxUsage(...args);
export const fetchZaiUsage: typeof import("../infra/provider-usage.fetch.zai.js").fetchZaiUsage =
  async (...args) => (await import("../infra/provider-usage.fetch.zai.js")).fetchZaiUsage(...args);
export { clampPercent, PROVIDER_LABELS } from "../infra/provider-usage.shared.js";
export {
  addProviderUsageModel,
  asProviderUsageObject,
  buildProviderUsageHistorySnapshot,
  cleanProviderUsageCredential,
  createProviderUsageDailyAccumulator,
  decodeProviderUsageAdminToken,
  encodeProviderUsageAdminToken,
  fetchProviderUsagePages,
  parseProviderUsageNonNegativeInteger,
  parseProviderUsageNonNegativeNumber,
  parseProviderUsageNumber,
  resolveProviderUsageDailyPeriod,
  resolveProviderUsageDisplayName,
} from "../infra/provider-usage.admin.js";
export {
  buildUsageErrorSnapshot,
  buildUsageHttpErrorSnapshot,
  fetchJson,
} from "../infra/provider-usage.fetch.shared.js";
