import { describe, expect, it } from "vitest";
import { resolveCronJobConfigRevision } from "./config-revision.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { loadCronStore, saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const { makeStorePath } = setupCronServiceSuite({ prefix: "cron-config-revision-" });

function makeJob(): CronJob {
  return {
    id: "job-1",
    name: "daily report",
    enabled: true,
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "Summarize the day" },
    delivery: { mode: "announce", channel: "telegram", to: "chat-1" },
    state: {},
  };
}

describe("resolveCronJobConfigRevision", () => {
  it("ignores runtime timestamps and scheduler state", () => {
    const original = makeJob();
    const cyclicState: Record<string, unknown> = {};
    cyclicState.self = cyclicState;
    const runtimeChanged: CronJob = {
      ...original,
      updatedAtMs: 9_000,
      state: {
        lastRunAtMs: 8_000,
        lastRunStatus: "ok",
        nextRunAtMs: 10_000,
        triggerState: cyclicState,
      },
    };

    expect(resolveCronJobConfigRevision(runtimeChanged)).toBe(
      resolveCronJobConfigRevision(original),
    );
  });

  it("changes for definition updates and same-id recreation", () => {
    const original = makeJob();

    expect(resolveCronJobConfigRevision({ ...original, description: "changed" })).not.toBe(
      resolveCronJobConfigRevision(original),
    );
    expect(resolveCronJobConfigRevision({ ...original, createdAtMs: 2_000 })).not.toBe(
      resolveCronJobConfigRevision(original),
    );
  });

  it("is stable across nested key ordering", () => {
    const original = makeJob();
    const reordered: CronJob = {
      ...original,
      payload: {
        kind: "command",
        argv: ["printenv"],
        env: { B: "2", A: "1" },
      },
    };
    const canonical: CronJob = {
      ...reordered,
      payload: {
        kind: "command",
        argv: ["printenv"],
        env: { A: "1", B: "2" },
      },
    };

    expect(resolveCronJobConfigRevision(reordered)).toBe(resolveCronJobConfigRevision(canonical));
  });

  it("preserves order when case-insensitive command env keys collide on Windows", () => {
    const firstWinsLast: CronJob = {
      ...makeJob(),
      payload: {
        kind: "command",
        argv: ["printenv"],
        env: { Path: "first", PATH: "second" },
      },
    };
    const secondWinsLast: CronJob = {
      ...firstWinsLast,
      payload: {
        kind: "command",
        argv: ["printenv"],
        env: { PATH: "second", Path: "first" },
      },
    };

    expect(resolveCronJobConfigRevision(firstWinsLast)).not.toBe(
      resolveCronJobConfigRevision(secondWinsLast),
    );
  });

  it("distinguishes inherited and explicitly cleared delivery fields", () => {
    const inherited = makeJob();
    const explicitlyCleared: CronJob = {
      ...inherited,
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "chat-1",
        failureDestination: { channel: undefined },
      },
    };

    expect(resolveCronJobConfigRevision(explicitlyCleared)).not.toBe(
      resolveCronJobConfigRevision(inherited),
    );
  });

  it("is stable across the SQLite store round-trip", async () => {
    const { storePath } = await makeStorePath();
    const job: CronJob = {
      ...makeJob(),
      agentId: undefined,
      description: undefined,
      payload: {
        kind: "agentTurn",
        message: "Summarize the day",
        toolsAllow: ["read"],
        toolsAllowIsDefault: false,
      },
      delivery: {
        mode: "announce",
        failureDestination: {
          channel: undefined,
          accountId: undefined,
        },
      },
    };

    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const reloaded = (await loadCronStore(storePath)).jobs[0];
    if (!reloaded) {
      throw new Error("expected the persisted cron job to reload");
    }

    expect(resolveCronJobConfigRevision(reloaded)).toBe(resolveCronJobConfigRevision(job));
  });

  it("matches SQLite normalization across schedule, payload, trigger, and alert variants", async () => {
    const { storePath } = await makeStorePath();
    const jobs: CronJob[] = [
      {
        ...makeJob(),
        id: "command-empty-env",
        schedule: { kind: "every", everyMs: Number.MAX_SAFE_INTEGER, anchorMs: 0 },
        payload: { kind: "command", argv: ["true"], env: {}, input: "" },
        failureAlert: false,
      },
      {
        ...makeJob(),
        id: "default-tools-without-list",
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "" },
        payload: {
          kind: "agentTurn",
          message: "Summarize the day",
          toolsAllowIsDefault: true,
        },
        failureAlert: {},
        trigger: { script: "json({ fire: true })", once: true },
      },
      {
        ...makeJob(),
        id: "windows-env-key-order",
        payload: {
          kind: "command",
          argv: ["printenv"],
          env: { Path: "first", PATH: "second" },
        },
      },
      {
        ...makeJob(),
        id: "default-empty-tools",
        schedule: { kind: "at", at: "2027-01-01T00:00:00.000Z" },
        payload: {
          kind: "agentTurn",
          message: "Summarize the day",
          toolsAllow: [],
          toolsAllowIsDefault: true,
        },
      },
      {
        ...makeJob(),
        id: "on-exit-system-event",
        schedule: { kind: "on-exit", command: "true", cwd: "/tmp" },
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "Process exited" },
        delivery: undefined,
        failureAlert: { after: 2, cooldownMs: 0, includeSkipped: false },
      },
    ];

    await saveCronStore(storePath, { version: 1, jobs });
    const reloadedById = new Map((await loadCronStore(storePath)).jobs.map((job) => [job.id, job]));

    for (const job of jobs) {
      const reloaded = reloadedById.get(job.id);
      if (!reloaded) {
        throw new Error(`expected persisted cron job ${job.id} to reload`);
      }
      expect(resolveCronJobConfigRevision(reloaded), job.id).toBe(
        resolveCronJobConfigRevision(job),
      );
    }
  });
});
