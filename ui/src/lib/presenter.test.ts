// Control UI tests cover cron schedule presentation.
import { describe, expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { formatCronSchedule } from "./presenter.ts";

function job(schedule: CronJob["schedule"]): CronJob {
  return {
    id: "job",
    name: "Job",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule,
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "test" },
  };
}

describe("formatCronSchedule", () => {
  it("formats every schedules", () => {
    expect(formatCronSchedule(job({ kind: "every", everyMs: 60_000 }))).toBe("Every 1m");
  });

  it("formats cron schedules", () => {
    expect(formatCronSchedule(job({ kind: "cron", expr: "0 * * * *" }))).toBe("Cron 0 * * * *");
  });

  it("formats on-exit schedules with the watched command instead of falling through to cron", () => {
    expect(formatCronSchedule(job({ kind: "on-exit", command: "make build" }))).toBe(
      "On exit: make build",
    );
  });

  it("includes the working directory for on-exit schedules when set", () => {
    expect(formatCronSchedule(job({ kind: "on-exit", command: "./watch.sh", cwd: "/repo" }))).toBe(
      "On exit: ./watch.sh (cwd: /repo)",
    );
  });
});
