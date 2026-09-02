// Round-trips each CronSchedule kind through canonical SQLite job JSON.
import { describe, expect, it } from "vitest";
import { makeCronJob } from "../delivery.test-helpers.js";
import type { CronSchedule } from "../types.js";
import { projectCronJobThroughStorageCodec } from "./row-codec.js";

function roundTrip(schedule: CronSchedule): CronSchedule | null {
  return projectCronJobThroughStorageCodec(makeCronJob({ schedule })).schedule;
}

describe("canonical cron schedule JSON round-trip", () => {
  it("round-trips the creator account through canonical job JSON", () => {
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

  it("round-trips scheduled authority through canonical job JSON", () => {
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

  it("round-trips store-private scheduled caller origin without adding a column", () => {
    const job = projectCronJobThroughStorageCodec({
      ...makeCronJob({}),
      toolsAllowProvenance: {
        version: 1,
        source: "final-executable-surface",
        callerOrigin: { kind: "local" },
      },
    });

    expect(job.toolsAllowProvenance?.callerOrigin).toEqual({ kind: "local" });
  });

  it("keeps private runtime authority out of job_json", () => {
    const runtimeAuthority = {
      version: 1 as const,
      runtimeId: "codex",
      namespace: "codex.apps",
      payload: { apps: [{ id: "calendar" }] },
    };
    const job = projectCronJobThroughStorageCodec({
      ...makeCronJob({}),
      runtimeAuthority,
      runtimeAuthorityRecoveryRequired: true,
    });
    expect(job.runtimeAuthority).toBeUndefined();
    expect(job.runtimeAuthorityRecoveryRequired).toBeUndefined();

    const malformed = projectCronJobThroughStorageCodec({
      ...makeCronJob({}),
      runtimeAuthority: { ...runtimeAuthority, version: 2 } as never,
    });
    expect(malformed.runtimeAuthority).toBeUndefined();
  });

  it("round-trips pacing through canonical job JSON", () => {
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

  it("round-trips a stream schedule through canonical job JSON", () => {
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

  it("keeps existing schedule kinds intact", () => {
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
});
