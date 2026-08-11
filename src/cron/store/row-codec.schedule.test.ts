// Round-trips each CronSchedule kind through the SQLite column codec so the
// on-exit command/cwd persistence (v1 reuses schedule_expr/schedule_tz) is
// covered alongside the existing kinds.
import { describe, expect, it } from "vitest";
import { makeCronJob } from "../delivery.test-helpers.js";
import type { CronSchedule } from "../types.js";
import { projectCronJobThroughStorageCodec } from "./row-codec.js";

function roundTrip(schedule: CronSchedule): CronSchedule | null {
  return projectCronJobThroughStorageCodec(makeCronJob({ schedule })).schedule;
}

describe("schedule column codec round-trip", () => {
  it("round-trips the creator account through the additive job_json envelope", () => {
    const job = projectCronJobThroughStorageCodec(
      makeCronJob({
        owner: {
          agentId: "main",
          sessionKey: "agent:main:discord:group:ops",
          accountId: "work",
        },
      }),
    );

    expect(job.owner).toEqual({
      agentId: "main",
      sessionKey: "agent:main:discord:group:ops",
      accountId: "work",
    });
  });

  it("round-trips scheduled authority through the additive job_json envelope", () => {
    const job = projectCronJobThroughStorageCodec(
      makeCronJob({
        owner: {
          agentId: "main",
          sessionKey: "agent:main:discord:group:ops",
          accountId: "work",
        },
        payload: { kind: "agentTurn", message: "run", toolsAllow: ["write"] },
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:discord:group:ops",
          ownerAccountId: "work",
        },
      }),
    );

    expect(job.scheduledToolPolicy).toEqual({
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:discord:group:ops",
      ownerAccountId: "work",
    });
  });

  it("round-trips pacing through the additive job_json envelope", () => {
    const job = projectCronJobThroughStorageCodec(
      makeCronJob({ pacing: { min: "15m", max: "4h" } }),
    );

    expect(job.pacing).toEqual({ min: "15m", max: "4h" });
  });

  it("round-trips an on-exit schedule with command + cwd", () => {
    expect(roundTrip({ kind: "on-exit", command: "make build", cwd: "/repo" })).toEqual({
      kind: "on-exit",
      command: "make build",
      cwd: "/repo",
    });
  });

  it("round-trips an on-exit schedule without cwd", () => {
    expect(roundTrip({ kind: "on-exit", command: "./watch.sh" })).toEqual({
      kind: "on-exit",
      command: "./watch.sh",
    });
  });

  it("round-trips a stream schedule through job_json without new columns", () => {
    expect(
      roundTrip({
        kind: "stream",
        command: ["node", "events.mjs"],
        cwd: "/repo",
        mode: "match",
        match: "^ready:",
        batchMs: 100,
        maxBatchBytes: 2_048,
      }),
    ).toEqual({
      kind: "stream",
      command: ["node", "events.mjs"],
      cwd: "/repo",
      mode: "match",
      match: "^ready:",
      batchMs: 100,
      maxBatchBytes: 2_048,
    });
  });

  it("keeps existing kinds intact (no cross-talk from on-exit column reuse)", () => {
    expect(roundTrip({ kind: "every", everyMs: 60_000 })).toEqual({
      kind: "every",
      everyMs: 60_000,
    });
    expect(roundTrip({ kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" })).toEqual({
      kind: "cron",
      expr: "0 9 * * *",
      tz: "Asia/Shanghai",
    });
    expect(roundTrip({ kind: "at", at: "2026-01-01T00:00:00.000Z" })).toEqual({
      kind: "at",
      at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("an on-exit row is decoded as on-exit, not cron (schedule_kind disambiguates)", () => {
    const decoded = roundTrip({ kind: "on-exit", command: "sleep 5" });
    expect(decoded?.kind).toBe("on-exit");
  });
});
