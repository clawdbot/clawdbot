import type { GatewayBrowserClient } from "../gateway.js";
import type { CostUsageSummary } from "../views/analytics.js";

export type AnalyticsState = {
  client: GatewayBrowserClient;
  analyticsLoading: boolean;
  analyticsError: string | null;
  analyticsData: CostUsageSummary | null;
  analyticsDays: number;
};

export async function loadAnalytics(state: AnalyticsState): Promise<void> {
  state.analyticsLoading = true;
  state.analyticsError = null;

  try {
    const res = await state.client.request("usage.cost", { days: state.analyticsDays });
    if (res.ok && res.result) {
      state.analyticsData = res.result as CostUsageSummary;
    } else {
      state.analyticsError = res.error?.message ?? "Failed to load usage data";
    }
  } catch (err) {
    state.analyticsError = err instanceof Error ? err.message : "Failed to load usage data";
  } finally {
    state.analyticsLoading = false;
  }
}
