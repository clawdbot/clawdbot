import { describe, expect, it } from "vitest";
import type { CronJob } from "../../api/types.ts";
import { resolveCronTimezoneSuggestions } from "./timezone-suggestions.ts";

function cronJob(timezone: string): CronJob {
  return {
    schedule: { kind: "cron", expr: "0 9 * * *", tz: timezone },
  } as CronJob;
}

describe("resolveCronTimezoneSuggestions", () => {
  it("prioritizes relevant zones before the browser catalog", () => {
    expect(
      resolveCronTimezoneSuggestions(
        [cronJob("Pacific/Chatham"), cronJob("UTC"), cronJob(" Pacific/Chatham ")],
        "Asia/Singapore",
        ["Europe/London", "America/New_York", "Asia/Singapore"],
      ),
    ).toEqual(["Asia/Singapore", "UTC", "Pacific/Chatham", "America/New_York", "Europe/London"]);
  });

  it("keeps useful suggestions when the browser catalog is unavailable", () => {
    expect(resolveCronTimezoneSuggestions([cronJob("America/St_Johns")], "", [])).toEqual([
      "UTC",
      "America/St_Johns",
    ]);
  });
});
