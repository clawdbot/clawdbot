import type { CronJob } from "../types.js";
import type { CronJobsSortBy, CronSortDir } from "./list-page-types.js";

export function sortCronJobs(
  jobs: CronJob[],
  sortBy: CronJobsSortBy,
  sortDir: CronSortDir,
): CronJob[] {
  const dir = sortDir === "desc" ? -1 : 1;
  return jobs.toSorted((a, b) => {
    let cmp;
    if (sortBy === "name") {
      const aName = typeof a.name === "string" ? a.name : "";
      const bName = typeof b.name === "string" ? b.name : "";
      cmp = aName.localeCompare(bName, undefined, { sensitivity: "base" });
    } else if (sortBy === "updatedAtMs") {
      cmp = a.updatedAtMs - b.updatedAtMs;
    } else {
      const aNext = a.state.nextRunAtMs;
      const bNext = b.state.nextRunAtMs;
      if (typeof aNext === "number" && typeof bNext === "number") {
        cmp = aNext - bNext;
      } else if (typeof aNext === "number") {
        cmp = -1;
      } else if (typeof bNext === "number") {
        cmp = 1;
      } else {
        cmp = 0;
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
