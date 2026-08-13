import "./schedule.js";

type CronScheduleTestApi = {
  clearCronScheduleCacheForTest(): void;
  getCronScheduleCacheSizeForTest(): number;
  getCronScheduleCacheMaxForTest(): number;
  hasCronInCacheForTest(expr: string, tz: string): boolean;
};

function getTestApi(): CronScheduleTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.cronScheduleTestApi")
  ] as CronScheduleTestApi;
}

export function clearCronScheduleCacheForTest(): void {
  getTestApi().clearCronScheduleCacheForTest();
}

export function getCronScheduleCacheSizeForTest(): number {
  return getTestApi().getCronScheduleCacheSizeForTest();
}

export function getCronScheduleCacheMaxForTest(): number {
  return getTestApi().getCronScheduleCacheMaxForTest();
}

export function hasCronInCacheForTest(expr: string, tz: string): boolean {
  return getTestApi().hasCronInCacheForTest(expr, tz);
}
