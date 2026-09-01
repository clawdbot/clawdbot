/** Shared filter, sort, and page result types for cron job listing. */
import type { CronJob, CronRunStatus } from "../types.js";

/** Enabled-state filter accepted by paginated cron listing. */
export type CronJobsEnabledFilter = "all" | "enabled" | "disabled";

/** Schedule-kind filter accepted by paginated cron listing. */
export type CronJobsScheduleKindFilter = "all" | "at" | "every" | "cron" | "on-exit" | "stream";

/** Last-run status filter, including jobs that have not produced a status yet. */
export type CronJobsLastRunStatusFilter = "all" | CronRunStatus | "unknown";

/** Condition-trigger filter accepted by paginated cron listing. */
export type CronJobsTriggerFilter = "all" | "conditional" | "unconditional";

/** Stable sort keys supported by paginated cron listing. */
export type CronJobsSortBy = "nextRunAtMs" | "updatedAtMs" | "name";

/** Sort direction for paginated cron listing. */
export type CronSortDir = "asc" | "desc";

/** Metadata attached to cron pages that are filtered by caller or operator-role scope. */
export type CronListVisibility = {
  mode: "caller" | "role";
  restricted: true;
  warning: string;
};

/** Combines independent scope disclosures without losing the original restriction reason. */
export function mergeCronListVisibility(
  current: CronListVisibility | undefined,
  added: Pick<CronListVisibility, "mode" | "warning">,
): CronListVisibility {
  return current
    ? {
        ...current,
        warning: `${current.warning} ${added.warning}`,
      }
    : {
        mode: added.mode,
        restricted: true,
        warning: added.warning,
      };
}

/** Input contract for filtered, sorted, offset-based cron job pages. */
export type CronListPageOptions = {
  includeDisabled?: boolean;
  limit?: number;
  offset?: number;
  query?: string;
  enabled?: CronJobsEnabledFilter;
  scheduleKind?: CronJobsScheduleKindFilter;
  lastRunStatus?: CronJobsLastRunStatusFilter;
  trigger?: CronJobsTriggerFilter;
  sortBy?: CronJobsSortBy;
  sortDir?: CronSortDir;
  agentId?: string;
};

/** Offset-page result returned by cron listPage callers. */
export type CronListPageResult<TJobs extends readonly CronJob[] = CronJob[]> = {
  jobs: TJobs;
  /** Opaque revision for the complete filtered, sorted result set. */
  snapshotRevision: string;
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
  /** Present when the page is a restricted view rather than a global inventory. */
  visibility?: CronListVisibility;
};
