import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readCanonicalCronListPage,
  resolveCronListPageNextOffset,
} from "../../cron/service/list-page-validation.js";

const CRON_SELF_LIST_MAX_PAGES = 50;
const CRON_SELF_LIST_MAX_SNAPSHOT_RESTARTS = 3;

function filterDeliveryPreviewsByJobId(previews: unknown, jobId: string): unknown {
  if (!isRecord(previews)) {
    return previews;
  }
  return Object.hasOwn(previews, jobId) ? { [jobId]: previews[jobId] } : {};
}

function filterCronListResultToJobId(result: unknown, jobId: string) {
  if (!isRecord(result) || !Array.isArray(result.jobs)) {
    throw new Error("cron.list returned an invalid inventory page");
  }
  const jobs = result.jobs.filter((job) => isRecord(job) && job.id === jobId);
  const filteredResult: Record<string, unknown> = {
    ...result,
    jobs,
    total: jobs.length,
    offset: 0,
    limit: jobs.length,
    hasMore: false,
    nextOffset: null,
    ...(Object.hasOwn(result, "deliveryPreviews")
      ? { deliveryPreviews: filterDeliveryPreviewsByJobId(result.deliveryPreviews, jobId) }
      : {}),
  };
  delete filteredResult.snapshotRevision;
  return filteredResult;
}

function cronListPageHasJob(result: { jobs: unknown[] }, jobId: string): boolean {
  return result.jobs.some((job) => isRecord(job) && job.id === jobId);
}

export async function listCronSelfJob(params: {
  jobId: string;
  pageSize: number;
  requestPage: (params: { limit: number; offset: number }) => Promise<unknown>;
}): Promise<unknown> {
  for (let restart = 0; restart <= CRON_SELF_LIST_MAX_SNAPSHOT_RESTARTS; restart += 1) {
    let offset = 0;
    let snapshotRevision: string | undefined;
    let total: number | undefined;
    let snapshotChanged = false;

    for (let pageNumber = 0; pageNumber < CRON_SELF_LIST_MAX_PAGES; pageNumber += 1) {
      const page = readCanonicalCronListPage(
        await params.requestPage({ limit: params.pageSize, offset }),
        params.pageSize,
      );
      if (
        (snapshotRevision !== undefined && page.snapshotRevision !== snapshotRevision) ||
        (total !== undefined && page.total !== total)
      ) {
        // The current job can move into an already-read offset page. Discard
        // the attempt instead of fabricating an empty self view.
        snapshotChanged = true;
        break;
      }
      snapshotRevision ??= page.snapshotRevision;
      total ??= page.total;
      const nextOffset = resolveCronListPageNextOffset(page, offset);
      if (cronListPageHasJob(page, params.jobId) || nextOffset === null) {
        return filterCronListResultToJobId(page, params.jobId);
      }
      offset = nextOffset;
    }

    if (!snapshotChanged) {
      throw new Error(
        "cron.list pagination exceeded maximum pages while reading current automation",
      );
    }
    if (restart === CRON_SELF_LIST_MAX_SNAPSHOT_RESTARTS) {
      throw new Error("cron.list inventory changed repeatedly while reading current automation");
    }
  }

  throw new Error("cron.list inventory changed repeatedly while reading current automation");
}
