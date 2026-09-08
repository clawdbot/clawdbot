import type { SessionsUsageResult } from "./data-types.ts";

type UsageCacheStatus = SessionsUsageResult["cacheStatus"];

export function isUsageCacheIncomplete(
  sessionsStatus: UsageCacheStatus,
  costStatus: UsageCacheStatus,
): boolean {
  return [sessionsStatus, costStatus].some((cache) => cache && cache.status !== "fresh");
}
