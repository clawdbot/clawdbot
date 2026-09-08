// Lazily binds trusted diagnostics exporters to the Gateway-owned provider-usage cache.
import { loadConfig } from "../config/io.js";
import type { ProviderUsageMetricsListener } from "../infra/provider-usage-metrics.types.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";

const loadProviderUsageCache = createLazyRuntimeModule(
  () => import("./server-methods/models-auth-status-usage-cache.js"),
);

export async function observeGatewayProviderUsageMetrics(params: {
  isActive: () => boolean;
  listener: ProviderUsageMetricsListener;
}): Promise<() => void> {
  const { observeProviderUsageMetrics } = await loadProviderUsageCache();
  if (!params.isActive()) {
    throw new Error("provider usage observer lease is no longer active");
  }
  return observeProviderUsageMetrics({
    getConfig: () => loadConfig(),
    listener: params.listener,
  });
}
