import type { CronDeliveryStatus, CronJob, CronRunStatus } from "../../cron/types.js";
import { normalizeAgentId } from "../../routing/session-key.js";

export function filterCronRunLogJobsByAgent(
  jobs: readonly CronJob[],
  agentId: string | undefined,
  defaultAgentId: string | undefined,
): CronJob[] {
  if (!agentId) {
    return [...jobs];
  }
  const normalizedAgentId = normalizeAgentId(agentId);
  return jobs.filter(
    (job) => normalizeAgentId(job.agentId ?? defaultAgentId) === normalizedAgentId,
  );
}

export function cronRunLogPageFilters(params: {
  limit?: number;
  offset?: number;
  statuses?: CronRunStatus[];
  status?: "all" | CronRunStatus;
  runId?: string;
  deliveryStatuses?: CronDeliveryStatus[];
  deliveryStatus?: CronDeliveryStatus;
  query?: string;
  sortDir?: "asc" | "desc";
}) {
  return {
    limit: params.limit,
    offset: params.offset,
    statuses: params.statuses,
    status: params.status,
    runId: params.runId,
    deliveryStatuses: params.deliveryStatuses,
    deliveryStatus: params.deliveryStatus,
    query: params.query,
    sortDir: params.sortDir,
  };
}
