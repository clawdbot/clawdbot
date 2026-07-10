// Control UI module implements usage cache status behavior.
import { t } from "../../i18n/index.ts";
import type { SessionsUsageResult } from "./data-types.ts";

type UsageCacheStatus = SessionsUsageResult["cacheStatus"];

export function mergeUsageCacheStatus(
  sessionsStatus: UsageCacheStatus,
  costStatus: UsageCacheStatus,
): UsageCacheStatus {
  if (!sessionsStatus) {
    return costStatus;
  }
  if (!costStatus) {
    return sessionsStatus;
  }
  const rank = { fresh: 0, partial: 1, stale: 2, refreshing: 3 } as const;
  const status =
    rank[costStatus.status] > rank[sessionsStatus.status]
      ? costStatus.status
      : sessionsStatus.status;
  const sessionsRefreshedAt =
    sessionsStatus.refreshedAt != null && sessionsStatus.refreshedAt > 0
      ? sessionsStatus.refreshedAt
      : undefined;
  const costRefreshedAt =
    costStatus.refreshedAt != null && costStatus.refreshedAt > 0
      ? costStatus.refreshedAt
      : undefined;
  const refreshedAt =
    sessionsRefreshedAt != null && costRefreshedAt != null
      ? Math.max(sessionsRefreshedAt, costRefreshedAt)
      : sessionsRefreshedAt ?? costRefreshedAt;
  return {
    status,
    cachedFiles: Math.max(sessionsStatus.cachedFiles, costStatus.cachedFiles),
    pendingFiles: Math.max(sessionsStatus.pendingFiles, costStatus.pendingFiles),
    staleFiles: Math.max(sessionsStatus.staleFiles, costStatus.staleFiles),
    refreshedAt,
  };
}

export function getUsageCacheRefreshTitle(cacheStatus: UsageCacheStatus): string | null {
  if (
    !cacheStatus ||
    (cacheStatus.status !== "refreshing" &&
      cacheStatus.status !== "stale" &&
      cacheStatus.status !== "partial")
  ) {
    return null;
  }
  return t("usage.cacheStatus.title", {
    status: t(`usage.cacheStatus.status.${cacheStatus.status}`),
    pending: String(cacheStatus.pendingFiles),
    stale: String(cacheStatus.staleFiles),
    cached: String(cacheStatus.cachedFiles),
  });
}
