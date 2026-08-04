import type { CronJob } from "../../api/types.ts";
import { sortUniqueStrings } from "../../lib/string-coerce.ts";

function resolveBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "";
  }
}

function resolveSupportedTimezones(): string[] {
  try {
    return Intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  return values
    .map((value) => value.trim())
    .filter((value) => {
      if (!value || seen.has(value)) {
        return false;
      }
      seen.add(value);
      return true;
    });
}

export function resolveCronTimezoneSuggestions(
  cronJobs: CronJob[],
  browserTimezone = resolveBrowserTimezone(),
  supportedTimezones = resolveSupportedTimezones(),
): string[] {
  const configuredTimezones = cronJobs.map((job) =>
    job.schedule.kind === "cron" && typeof job.schedule.tz === "string" ? job.schedule.tz : "",
  );
  return uniqueInOrder([
    browserTimezone,
    "UTC",
    ...configuredTimezones,
    ...sortUniqueStrings(supportedTimezones.map((value) => value.trim()).filter(Boolean)),
  ]);
}
