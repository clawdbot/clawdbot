import { resolveCronListSnapshotRevision } from "../../cron/list-snapshot-revision.js";
import type {
  CronListPageOptions,
  CronListPageResult,
} from "../../cron/service/list-page-types.js";
import type { CronJob } from "../../cron/types.js";

type CronListCallerScopeContext = {
  cron: {
    listPage(opts?: CronListPageOptions): Promise<CronListPageResult>;
  };
};

const CRON_LIST_SCOPED_SNAPSHOT_MAX_ATTEMPTS = 3;

export async function listCronPageWithVisibility({
  matchesJob,
  context,
  options,
}: {
  matchesJob: (job: CronJob) => boolean;
  context: CronListCallerScopeContext;
  options: CronListPageOptions;
}): Promise<CronListPageResult> {
  let stableScopedJobs: CronJob[] | undefined;
  for (let attempt = 0; attempt < CRON_LIST_SCOPED_SNAPSHOT_MAX_ATTEMPTS; attempt += 1) {
    const scopedJobs: CronJob[] = [];
    let offset = 0;
    let snapshotRevision: string | undefined;
    let snapshotChanged = false;

    for (;;) {
      const sourcePage = await context.cron.listPage({
        ...options,
        limit: 200,
        offset,
      });
      if (snapshotRevision && sourcePage.snapshotRevision !== snapshotRevision) {
        snapshotChanged = true;
        break;
      }
      snapshotRevision = sourcePage.snapshotRevision;

      scopedJobs.push(...sourcePage.jobs.filter(matchesJob));

      if (
        !sourcePage.hasMore ||
        sourcePage.nextOffset === null ||
        sourcePage.nextOffset <= offset
      ) {
        break;
      }
      offset = sourcePage.nextOffset;
    }
    if (!snapshotChanged && snapshotRevision) {
      stableScopedJobs = scopedJobs;
      break;
    }
  }
  if (!stableScopedJobs) {
    throw new Error("cron.list changed repeatedly while applying caller scope");
  }

  const total = stableScopedJobs.length;
  const pageOffset = Math.max(0, Math.min(total, Math.floor(options.offset ?? 0)));
  const defaultLimit = total === 0 ? 50 : total;
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? defaultLimit)));
  const jobs = stableScopedJobs.slice(pageOffset, pageOffset + limit);
  const nextOffset = pageOffset + jobs.length;
  return {
    jobs,
    // Never expose the source revision: it includes jobs hidden by caller scope.
    snapshotRevision: resolveCronListSnapshotRevision(stableScopedJobs),
    total,
    offset: pageOffset,
    limit,
    hasMore: nextOffset < total,
    nextOffset: nextOffset < total ? nextOffset : null,
  };
}
