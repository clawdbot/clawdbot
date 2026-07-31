import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { cronStreamScheduleKey } from "./stream-schedule.js";
import type { CronJobCreate } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-stream-validation-" });

function streamJob(overrides: Partial<CronJobCreate> = {}): CronJobCreate {
  return {
    name: "stream",
    enabled: true,
    schedule: { kind: "stream", command: [process.execPath, "-e", "setInterval(() => {}, 1000)"] },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "handle events" },
    ...overrides,
  };
}

async function createCron(triggersEnabled: boolean) {
  const { storePath } = await makeStorePath();
  const cron = new CronService({
    storePath,
    cronEnabled: true,
    cronConfig: { triggers: { enabled: triggersEnabled } },
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  await cron.start();
  return cron;
}

describe("cron stream schedule validation", () => {
  it("rejects creation while cron triggers are disabled", async () => {
    const cron = await createCron(false);
    try {
      await expect(cron.add(streamJob())).rejects.toThrow("cron.triggers.enabled=true");
    } finally {
      cron.stop();
    }
  });

  it("validates match regexes and command payload ambiguity", async () => {
    const cron = await createCron(true);
    try {
      await expect(
        cron.add(streamJob({ schedule: { kind: "stream", command: ["echo"], mode: "match" } })),
      ).rejects.toThrow("match is required");
      await expect(
        cron.add(
          streamJob({
            schedule: { kind: "stream", command: ["echo"], mode: "match", match: "[" },
          }),
        ),
      ).rejects.toThrow("safe regular expression");
      await expect(
        cron.add(
          streamJob({
            schedule: {
              kind: "stream",
              command: ["echo"],
              mode: "match",
              match: "^(a+)+$",
            },
          }),
        ),
      ).rejects.toThrow("unsafe-nested-repetition");
      await expect(
        cron.add(
          streamJob({
            schedule: { kind: "stream", command: ["echo"], match: "^ready" },
          }),
        ),
      ).rejects.toThrow('match requires mode="match"');
      await expect(
        cron.add(
          streamJob({
            payload: { kind: "command", argv: ["echo", "payload"] },
          }),
        ),
      ).rejects.toThrow("cannot use command payloads");
    } finally {
      cron.stop();
    }
  });

  it("allows a script payload without a gate and rejects one with a gate", async () => {
    const cron = await createCron(true);
    const scriptPayload = { kind: "script" as const, script: "return {}" };
    try {
      await expect(
        cron.add(
          streamJob({
            sessionTarget: "isolated",
            payload: scriptPayload,
          }),
        ),
      ).resolves.toMatchObject({ payload: scriptPayload });
      await expect(
        cron.add(
          streamJob({
            sessionTarget: "isolated",
            payload: scriptPayload,
            trigger: { script: "return { fire: true }" },
          }),
        ),
      ).rejects.toThrow("cannot be combined with a condition trigger");
    } finally {
      cron.stop();
    }
  });

  it("clamps explicit batch bounds during normalization", async () => {
    const cron = await createCron(true);
    try {
      const job = await cron.add(
        streamJob({
          schedule: {
            kind: "stream",
            command: ["echo"],
            batchMs: 1,
            maxBatchBytes: 999_999,
          },
        }),
      );
      expect(job.schedule).toMatchObject({ batchMs: 50, maxBatchBytes: 65_536 });
      await expect(
        cron.add(
          streamJob({
            schedule: { kind: "stream", command: ["echo"], batchMs: 1.5 },
          }),
        ),
      ).rejects.toThrow("batching values must be integers");
    } finally {
      cron.stop();
    }
  });

  it("routes restart exhaustion through normal failure alerts", async () => {
    const { storePath } = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      cronConfig: {
        triggers: { enabled: true },
        failureAlert: { enabled: true, after: 5, cooldownMs: 0 },
      },
      log: logger,
      enqueueSystemEvent,
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    await cron.start();
    try {
      const created = await cron.add(streamJob());
      await cron.recordExternalFailure(created.id, "stream source exhausted restarts", {
        streamStatus: "error",
        streamRestartExhausted: true,
        streamConsecutiveFailures: 5,
      });
      expect(cron.getJob(created.id)?.state).toMatchObject({
        lastRunStatus: "error",
        consecutiveErrors: 5,
        streamStatus: "error",
        streamRestartExhausted: true,
      });
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("stream source exhausted restarts"),
        expect.any(Object),
      );
    } finally {
      cron.stop();
    }
  });

  it("rotates logical source identity only when source ownership changes", async () => {
    const cron = await createCron(true);
    try {
      const created = await cron.add(streamJob());
      const initialIdentity = created.state.streamSourceIdentity;
      expect(initialIdentity).toEqual(expect.any(String));

      const equivalent = await cron.update(created.id, {
        schedule: structuredClone(created.schedule),
      });
      expect(equivalent.state.streamSourceIdentity).toBe(initialIdentity);

      const replaced = await cron.update(created.id, {
        schedule: { kind: "stream", command: ["replacement-source"] },
      });
      expect(replaced.state.streamSourceIdentity).not.toBe(initialIdentity);

      const disabled = await cron.update(created.id, { enabled: false });
      expect(disabled.state.streamSourceIdentity).not.toBe(replaced.state.streamSourceIdentity);

      const reenabled = await cron.update(created.id, { enabled: true });
      expect(reenabled.state.streamSourceIdentity).not.toBe(disabled.state.streamSourceIdentity);
    } finally {
      cron.stop();
    }
  });

  it("ignores stale owner writes after an A-to-B-to-A source replacement", async () => {
    const cron = await createCron(true);
    try {
      const created = await cron.add(streamJob());
      if (created.schedule.kind !== "stream") {
        throw new Error("expected stream schedule");
      }
      const oldSchedule = structuredClone(created.schedule);
      const oldScheduleKey = cronStreamScheduleKey(oldSchedule);
      const oldSourceIdentity = created.state.streamSourceIdentity;
      if (!oldSourceIdentity) {
        throw new Error("expected stream source identity");
      }
      await cron.update(created.id, {
        schedule: { kind: "stream", command: ["replacement-source"] },
      });
      const restored = await cron.update(created.id, { schedule: oldSchedule });
      if (restored.schedule.kind !== "stream") {
        throw new Error("expected restored stream schedule");
      }
      expect(cronStreamScheduleKey(restored.schedule)).toBe(oldScheduleKey);
      expect(restored.state.streamSourceIdentity).not.toBe(oldSourceIdentity);

      await expect(
        cron.updateExternalState(created.id, oldScheduleKey, oldSourceIdentity, {
          streamStatus: "stopped",
        }),
      ).resolves.toBe(false);
      await cron.updateExternalCounters(created.id, {
        streamDroppedBatches: 1,
        streamCoalescedBatches: 0,
      });
      await cron.recordExternalFailure(
        created.id,
        "stale source failure",
        {
          streamStatus: "error",
          streamRestartExhausted: true,
        },
        { scheduleKey: oldScheduleKey, identity: oldSourceIdentity },
      );

      expect(cron.getJob(created.id)?.state).not.toMatchObject({
        streamStatus: "error",
        streamRestartExhausted: true,
      });
      expect(cron.getJob(created.id)?.state.streamDroppedBatches).toBe(1);
    } finally {
      cron.stop();
    }
  });
});
