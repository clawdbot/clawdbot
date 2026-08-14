import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CronListPageResult } from "./list-page-types.js";

type CanonicalCronListPage<TJob = unknown> = Omit<CronListPageResult, "jobs"> & { jobs: TJob[] };

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function readCanonicalCronListPage<TJob = unknown>(
  value: unknown,
  maxLimit: number,
): CanonicalCronListPage<TJob> {
  if (!isRecord(value) || !Array.isArray(value.jobs)) {
    throw new Error("cron.list returned an invalid inventory page");
  }
  const page = value;
  const jobs = value.jobs as TJob[];
  const limit = typeof page.limit === "number" ? page.limit : 0;
  if (
    typeof page.snapshotRevision !== "string" ||
    page.snapshotRevision.length === 0 ||
    !isSafeNonNegativeInteger(page.total) ||
    !isSafeNonNegativeInteger(page.offset) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > maxLimit ||
    jobs.length > limit ||
    typeof page.hasMore !== "boolean" ||
    (page.nextOffset !== null && !isSafeNonNegativeInteger(page.nextOffset))
  ) {
    throw new Error("cron.list returned an invalid inventory page");
  }
  return page as CanonicalCronListPage<TJob>;
}

export function resolveCronListPageNextOffset(
  page: CanonicalCronListPage,
  requestedOffset: number,
): number | null {
  const nextOffset = requestedOffset + page.jobs.length;
  if (
    page.offset !== requestedOffset ||
    !Number.isSafeInteger(nextOffset) ||
    nextOffset > page.total ||
    (page.hasMore
      ? page.nextOffset !== nextOffset || nextOffset <= requestedOffset || nextOffset >= page.total
      : page.nextOffset !== null || nextOffset !== page.total)
  ) {
    throw new Error("cron.list returned an invalid inventory page");
  }
  return page.hasMore ? nextOffset : null;
}
