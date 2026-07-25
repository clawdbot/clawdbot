import "./session-cost-usage.js";

type UsageCostRefreshParams = {
  agentId?: string;
  sessionFiles?: string[];
};

type SessionCostUsageTestApi = {
  clearUsageCostRefreshesForTest(): void;
  requestCostUsageCacheRefresh(params?: UsageCostRefreshParams): void;
  usageCostRefreshRuntime: {
    refreshCostUsageCacheForAgent(params?: UsageCostRefreshParams): Promise<"busy" | "refreshed">;
  };
};

function getTestApi(): SessionCostUsageTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.sessionCostUsageTestApi")
  ] as SessionCostUsageTestApi;
}

export const testing: SessionCostUsageTestApi = {
  clearUsageCostRefreshesForTest() {
    getTestApi().clearUsageCostRefreshesForTest();
  },
  requestCostUsageCacheRefresh(params) {
    getTestApi().requestCostUsageCacheRefresh(params);
  },
  get usageCostRefreshRuntime() {
    return getTestApi().usageCostRefreshRuntime;
  },
};
