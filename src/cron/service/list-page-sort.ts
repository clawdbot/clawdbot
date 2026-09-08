import type { CronJob } from "../types.js";
import type { CronJobsSortBy, CronSortDir } from "./list-page-types.js";

export function sortCronJobs(
  jobs: CronJob[],
  sortBy: CronJobsSortBy,
  sortDir: CronSortDir,
): CronJob[] {
  const dir = sortDir === "desc" ? -1 : 1;
  // Explicit options bypass native localeCompare caching; keep collation local to this sort.
  let compareNames: Intl.Collator["compare"] | undefined;
  // oxlint-disable-next-line unicorn/no-array-sort -- Both callers supply fresh filtered arrays.
  return jobs.sort((a, b) => {
    let cmp = 0;
    if (sortBy === "name") {
      const aName = typeof a.name === "string" ? a.name : "";
      const bName = typeof b.name === "string" ? b.name : "";
      // oxlint-disable-next-line typescript/unbound-method -- Intl.Collator.compare returns a bound function.
      compareNames ??= new Intl.Collator(undefined, { sensitivity: "base" }).compare;
      cmp = compareNames(aName, bName);
    } else if (sortBy === "updatedAtMs") {
      cmp = a.updatedAtMs - b.updatedAtMs;
    } else {
      const aNext = a.state.nextRunAtMs;
      const bNext = b.state.nextRunAtMs;
      if (typeof aNext === "number" && typeof bNext === "number") {
        cmp = aNext - bNext;
      } else if (typeof aNext === "number" || typeof bNext === "number") {
        // Missing run times stay last in either direction so paused jobs cannot hide scheduled work.
        return typeof aNext === "number" ? -1 : 1;
      }
    }
    if (cmp !== 0) {
      return cmp * dir;
    }
    // Stable id tiebreaker keeps pagination deterministic when sort keys match.
    const aId = typeof a.id === "string" ? a.id : "";
    const bId = typeof b.id === "string" ? b.id : "";
    return aId.localeCompare(bId);
  });
}
