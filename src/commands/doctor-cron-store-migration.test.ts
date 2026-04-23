import { describe, expect, it } from "vitest";
import { DEFAULT_TOP_OF_HOUR_STAGGER_MS } from "../cron/stagger.js";
import { normalizeStoredCronJobs } from "./doctor-cron-store-migration.js";

function makeLegacyJob(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "job-legacy",
    agentId: undefined,
    name: "Legacy job",
    description: null,
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "systemEvent",
      text: "tick",
    },
    state: {},
    ...overrides,
  };
}

function normalizeOneJob(job: Record<string, unknown>) {
  const jobs = [job];
  const result = normalizeStoredCronJobs(jobs);
  return { job: jobs[0], result };
}

describe("normalizeStoredCronJobs", () => {
  it("normalizes legacy cron fields and reports migration issues", () => {
    const jobs = [
      {
        jobId: "legacy-job",
        schedule: { kind: "cron", cron: "*/5 * * * *", tz: "UTC" },
        message: "say hi",
        model: "openai/gpt-5.5",
        deliver: true,
        provider: " TeLeGrAm ",
        to: "12345",
        threadId: " 77 ",
      },
    ] as Array<Record<string, unknown>>;

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(true);
    expect(result.issues).toMatchObject({
      jobId: 1,
      legacyScheduleCron: 1,
      legacyTopLevelPayloadFields: 1,
      legacyTopLevelDeliveryFields: 1,
    });

    const [job] = jobs;
    expect(job?.jobId).toBeUndefined();
    expect(job?.id).toBe("legacy-job");
    expect(job?.schedule).toMatchObject({
      kind: "cron",
      expr: "*/5 * * * *",
      tz: "UTC",
    });
    expect(job?.message).toBeUndefined();
    expect(job?.provider).toBeUndefined();
    expect(job?.delivery).toMatchObject({
      mode: "announce",
      channel: "telegram",
      to: "12345",
      threadId: "77",
    });
    expect(job?.payload).toMatchObject({
      kind: "agentTurn",
      message: "say hi",
      model: "openai/gpt-5.5",
    });
  });

  it("normalizes payload provider alias into channel", () => {
    const jobs = [
      {
        id: "legacy-provider",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: {
          kind: "agentTurn",
          message: "ping",
          provider: " Slack ",
        },
      },
    ] as Array<Record<string, unknown>>;

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(true);
    expect(result.issues.legacyPayloadProvider).toBe(1);
    expect(jobs[0]?.payload).toMatchObject({
      kind: "agentTurn",
      message: "ping",
    });
    const payload = jobs[0]?.payload as Record<string, unknown> | undefined;
    expect(payload?.provider).toBeUndefined();
    expect(jobs[0]?.delivery).toMatchObject({
      mode: "announce",
      channel: "slack",
    });
  });

  it("does not report legacyPayloadKind for already-normalized payload kinds", () => {
    const jobs = [
      {
        id: "normalized-agent-turn",
        name: "normalized",
        enabled: true,
        wakeMode: "now",
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
        payload: { kind: "agentTurn", message: "ping" },
        sessionTarget: "isolated",
        delivery: { mode: "announce" },
        state: {},
      },
    ] as Array<Record<string, unknown>>;

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(false);
    expect(result.issues.legacyPayloadKind).toBeUndefined();
  });

  it("normalizes whitespace-padded and non-canonical payload kinds", () => {
    const jobs = [
      {
        id: "spaced-agent-turn",
        name: "normalized",
        enabled: true,
        wakeMode: "now",
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
        payload: { kind: " agentTurn ", message: "ping" },
        sessionTarget: "isolated",
        delivery: { mode: "announce" },
        state: {},
      },
      {
        id: "upper-system-event",
        name: "normalized",
        enabled: true,
        wakeMode: "now",
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
        payload: { kind: "SYSTEMEVENT", text: "pong" },
        sessionTarget: "main",
        delivery: { mode: "announce" },
        state: {},
      },
    ] as Array<Record<string, unknown>>;

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(true);
    expect(result.issues.legacyPayloadKind).toBe(2);
    expect(jobs[0]?.payload).toMatchObject({ kind: "agentTurn", message: "ping" });
    expect(jobs[1]?.payload).toMatchObject({ kind: "systemEvent", text: "pong" });
  });

  it("normalizes isolated legacy jobs without mutating runtime code paths", () => {
    const { job, result } = normalizeOneJob(
      makeLegacyJob({
        id: "job-1",
        sessionKey: "  agent:main:discord:channel:ops  ",
        schedule: { kind: "at", atMs: 1_700_000_000_000 },
        sessionTarget: "isolated",
        payload: {
          kind: "agentTurn",
          message: "hi",
          deliver: true,
          channel: "telegram",
          to: "7200373102",
          bestEffortDeliver: true,
        },
        isolation: { postToMainPrefix: "Cron" },
      }),
    );

    expect(result.mutated).toBe(true);
    expect(job.sessionKey).toBe("agent:main:discord:channel:ops");
    expect(job.delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "7200373102",
      bestEffort: true,
    });
    expect("isolation" in job).toBe(false);

    const payload = job.payload as Record<string, unknown>;
    expect(payload.deliver).toBeUndefined();
    expect(payload.channel).toBeUndefined();
    expect(payload.to).toBeUndefined();
    expect(payload.bestEffortDeliver).toBeUndefined();

    const schedule = job.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("at");
    expect(schedule.at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(schedule.atMs).toBeUndefined();
  });

  it("preserves stored custom session targets", () => {
    const { job } = normalizeOneJob(
      makeLegacyJob({
        id: "job-custom-session",
        name: "Custom session",
        schedule: { kind: "cron", expr: "0 23 * * *", tz: "UTC" },
        sessionTarget: "session:ProjectAlpha",
        payload: {
          kind: "agentTurn",
          message: "hello",
        },
      }),
    );

    expect(job.sessionTarget).toBe("session:ProjectAlpha");
    expect(job.delivery).toEqual({ mode: "announce" });
  });

  it("adds anchorMs to legacy every schedules", () => {
    const createdAtMs = 1_700_000_000_000;
    const { job } = normalizeOneJob(
      makeLegacyJob({
        id: "job-every-legacy",
        name: "Legacy every",
        createdAtMs,
        updatedAtMs: createdAtMs,
        schedule: { kind: "every", everyMs: 120_000 },
      }),
    );

    const schedule = job.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("every");
    expect(schedule.anchorMs).toBe(createdAtMs);
  });

  it("adds default staggerMs to legacy recurring top-of-hour cron schedules", () => {
    const { job } = normalizeOneJob(
      makeLegacyJob({
        id: "job-cron-legacy",
        name: "Legacy cron",
        schedule: { kind: "cron", expr: "0 */2 * * *", tz: "UTC" },
      }),
    );

    const schedule = job.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("cron");
    expect(schedule.staggerMs).toBe(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
  });

  it("adds default staggerMs to legacy 6-field top-of-hour cron schedules", () => {
    const { job } = normalizeOneJob(
      makeLegacyJob({
        id: "job-cron-seconds-legacy",
        name: "Legacy cron seconds",
        schedule: { kind: "cron", expr: "0 0 */3 * * *", tz: "UTC" },
      }),
    );

    const schedule = job.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("cron");
    expect(schedule.staggerMs).toBe(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
  });

  it("removes invalid legacy staggerMs from non top-of-hour cron schedules", () => {
    const { job } = normalizeOneJob(
      makeLegacyJob({
        id: "job-cron-minute-legacy",
        name: "Legacy minute cron",
        schedule: {
          kind: "cron",
          expr: "17 * * * *",
          tz: "UTC",
          staggerMs: "bogus",
        },
      }),
    );

    const schedule = job.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("cron");
    expect(schedule.staggerMs).toBeUndefined();
  });

  it("migrates legacy string schedules and command-only payloads (#18445)", () => {
    const { job, result } = normalizeOneJob({
      id: "imessage-refresh",
      name: "iMessage Refresh",
      enabled: true,
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_000,
      schedule: "0 */2 * * *",
      command: "bash /tmp/imessage-refresh.sh",
      timeout: 120,
      state: {},
    });

    expect(result.mutated).toBe(true);
    expect(job.schedule).toEqual(
      expect.objectContaining({
        kind: "cron",
        expr: "0 */2 * * *",
      }),
    );
    expect(job.sessionTarget).toBe("main");
    expect(job.wakeMode).toBe("now");
    expect(job.payload).toEqual({
      kind: "systemEvent",
      text: "bash /tmp/imessage-refresh.sh",
    });
    expect("command" in job).toBe(false);
    expect("timeout" in job).toBe(false);
  });
});
