// Lazily binds trusted diagnostics exporters to the Gateway-owned provider-usage cache.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderUsageMetricsListener } from "../infra/provider-usage-metrics.types.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";

const loadProviderUsageCache = createLazyRuntimeModule(
  () => import("./server-methods/models-auth-status-usage-cache.js"),
);

export async function observeGatewayProviderUsageMetrics(params: {
  config: OpenClawConfig;
  listener: ProviderUsageMetricsListener;
}): Promise<() => void> {
  const { observeProviderUsageMetrics } = await loadProviderUsageCache();
  return observeProviderUsageMetrics(params);
}
