import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronJobsListResult } from "../../api/types.ts";

type CronScopeState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  cronAgentId: string | null;
  cronFailingCount: number | null;
  cronScopedTotal: number | null;
  cronScopedNextWakeAtMs: number | null;
};

export async function loadCronFailingCount(state: CronScopeState) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    // The stats card needs an unfiltered total; the jobs table holds only the
    // current filtered page. limit=1 because only `total` matters.
    const res = await state.client.request<CronJobsListResult>("cron.list", {
      ...(state.cronAgentId ? { agentId: state.cronAgentId } : {}),
      enabled: "enabled",
      lastRunStatus: "error",
      limit: 1,
      offset: 0,
    });
    state.cronFailingCount = typeof res?.total === "number" ? res.total : null;
  } catch {
    state.cronFailingCount = null;
  }
}

export async function loadCronScopeStats(state: CronScopeState) {
  if (!state.client || !state.connected || !state.cronAgentId) {
    state.cronScopedTotal = null;
    state.cronScopedNextWakeAtMs = null;
    return;
  }
  try {
    const [allJobs, nextEnabledJob] = await Promise.all([
      state.client.request<CronJobsListResult>("cron.list", {
        agentId: state.cronAgentId,
        includeDisabled: true,
        limit: 1,
        offset: 0,
      }),
      state.client.request<CronJobsListResult>("cron.list", {
        agentId: state.cronAgentId,
        enabled: "enabled",
        limit: 1,
        offset: 0,
        sortBy: "nextRunAtMs",
        sortDir: "asc",
      }),
    ]);
    state.cronScopedTotal = typeof allJobs.total === "number" ? allJobs.total : null;
    const nextRunAtMs = nextEnabledJob.jobs[0]?.state?.nextRunAtMs;
    state.cronScopedNextWakeAtMs =
      typeof nextRunAtMs === "number" && Number.isFinite(nextRunAtMs) ? nextRunAtMs : null;
  } catch {
    state.cronScopedTotal = null;
    state.cronScopedNextWakeAtMs = null;
  }
}
