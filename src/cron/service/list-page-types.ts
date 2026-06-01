import type { CronJob, CronRunStatus } from "../types.js";

/** Enabled-state filter accepted by paginated cron listing. */
export type CronJobsEnabledFilter = "all" | "enabled" | "disabled";

/** Schedule-kind filter accepted by paginated cron listing. */
export type CronJobsScheduleKindFilter = "all" | "at" | "every" | "cron";

/** Last-run status filter, including jobs that have not produced a status yet. */
export type CronJobsLastRunStatusFilter = "all" | CronRunStatus | "unknown";

/** Stable sort keys supported by paginated cron listing. */
export type CronJobsSortBy = "nextRunAtMs" | "updatedAtMs" | "name";

/** Sort direction for paginated cron listing. */
export type CronSortDir = "asc" | "desc";

/** Input contract for filtered, sorted, offset-based cron job pages. */
export type CronListPageOptions = {
  includeDisabled?: boolean;
  limit?: number;
  offset?: number;
  query?: string;
  enabled?: CronJobsEnabledFilter;
  scheduleKind?: CronJobsScheduleKindFilter;
  lastRunStatus?: CronJobsLastRunStatusFilter;
  sortBy?: CronJobsSortBy;
  sortDir?: CronSortDir;
  agentId?: string;
};

/** Offset-page result returned by cron listPage callers. */
export type CronListPageResult<TJobs extends readonly CronJob[] = CronJob[]> = {
  jobs: TJobs;
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
};
