// Public usage fetch helpers for provider plugins.
import { createLazyRuntimeMethod } from "../shared/lazy-runtime.js";

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
  createLazyRuntimeMethod(
    () => import("../infra/provider-usage.fetch.claude.js"),
    (runtime) => runtime.fetchClaudeUsage,
  );
export const fetchCodexUsage: typeof import("../infra/provider-usage.fetch.codex.js").fetchCodexUsage =
  createLazyRuntimeMethod(
    () => import("../infra/provider-usage.fetch.codex.js"),
    (runtime) => runtime.fetchCodexUsage,
  );
export const fetchDeepSeekUsage: typeof import("../infra/provider-usage.fetch.deepseek.js").fetchDeepSeekUsage =
  createLazyRuntimeMethod(
    () => import("../infra/provider-usage.fetch.deepseek.js"),
    (runtime) => runtime.fetchDeepSeekUsage,
  );
export const fetchGeminiUsage: typeof import("../infra/provider-usage.fetch.gemini.js").fetchGeminiUsage =
  createLazyRuntimeMethod(
    () => import("../infra/provider-usage.fetch.gemini.js"),
    (runtime) => runtime.fetchGeminiUsage,
  );
export const fetchMinimaxUsage: typeof import("../infra/provider-usage.fetch.minimax.js").fetchMinimaxUsage =
  createLazyRuntimeMethod(
    () => import("../infra/provider-usage.fetch.minimax.js"),
    (runtime) => runtime.fetchMinimaxUsage,
  );
export const fetchZaiUsage: typeof import("../infra/provider-usage.fetch.zai.js").fetchZaiUsage =
  createLazyRuntimeMethod(
    () => import("../infra/provider-usage.fetch.zai.js"),
    (runtime) => runtime.fetchZaiUsage,
  );
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
