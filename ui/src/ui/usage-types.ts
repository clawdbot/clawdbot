import type {
  SessionUsageTimePoint as SharedSessionUsageTimePoint,
  SessionUsageTimeSeries as SharedSessionUsageTimeSeries,
} from "../../../src/shared/session-usage-timeseries-types.js";
import type { SessionsUsageResult as SharedSessionsUsageResult } from "../../../src/shared/usage-types.js";

export type SessionsUsageEntry = SharedSessionsUsageResult["sessions"][number];
export type SessionsUsageTotals = SharedSessionsUsageResult["totals"];
export type SessionsUsageResult = SharedSessionsUsageResult;

export type CostUsageDailyEntry = SessionsUsageTotals & { date: string };

export type CostUsageSummary = {
  updatedAt: number;
  days: number;
  daily: CostUsageDailyEntry[];
  totals: SessionsUsageTotals;
  cacheStatus?: SharedSessionsUsageResult["cacheStatus"];
};

export type SessionUsageTimePoint = SharedSessionUsageTimePoint;

export type SessionUsageTimeSeries = SharedSessionUsageTimeSeries;
