import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-stream-trigger-" });

async function createHarness(fire: boolean) {
  const { storePath } = await makeStorePath();
  const evaluateCronTrigger = vi.fn(async () => ({
    kind: "evaluated" as const,
    fire,
    message: fire ? "gate message" : undefined,
    state: { seen: true },
  }));
  const runIsolatedAgentJob = vi.fn(
    async (): Promise<{ status: "ok" | "error"; error?: string }> => ({ status: "ok" }),
  );
  const cron = new CronService({
    storePath,
    cronEnabled: true,
    cronConfig: { triggers: { enabled: true } },
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    evaluateCronTrigger,
    runIsolatedAgentJob,
  });
  await cron.start();
  const job = await cron.add({
    name: "stream gate",
    enabled: true,
    schedule: { kind: "stream", command: ["echo"] },
    trigger: { script: "json({ fire: true })" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "base" },
  });
  return { cron, evaluateCronTrigger, job, runIsolatedAgentJob };
}

describe("cron stream trigger composition", () => {
  it("drops a fire:false batch and persists gate state", async () => {
    const harness = await createHarness(false);
    try {
      await harness.cron.run(harness.job.id, "force", {
        evaluateTrigger: true,
        streamBatch: "quiet batch",
        payload: { kind: "agentTurn", message: "base" },
      });
      expect(harness.evaluateCronTrigger).toHaveBeenCalledWith(
        expect.objectContaining({ streamBatch: "quiet batch" }),
      );
      expect(harness.cron.getJob(harness.job.id)?.state.triggerState).toEqual({ seen: true });
      expect(harness.runIsolatedAgentJob).not.toHaveBeenCalled();
    } finally {
      harness.cron.stop();
    }
  });

  it("fires with gate message followed by the stream batch", async () => {
    const harness = await createHarness(true);
    try {
      await harness.cron.run(harness.job.id, "force", {
        evaluateTrigger: true,
        streamBatch: "firing batch",
        payload: { kind: "agentTurn", message: "base" },
      });
      expect(harness.runIsolatedAgentJob).toHaveBeenCalledWith(
        expect.objectContaining({ message: "base\n\ngate message\n\nfiring batch" }),
      );
    } finally {
      harness.cron.stop();
    }
  });

  it("rotates source identity when a once trigger auto-disables the stream", async () => {
    const harness = await createHarness(true);
    try {
      const configured = await harness.cron.update(harness.job.id, {
        trigger: { script: "json({ fire: true })", once: true },
      });
      const sourceIdentity = configured.state.streamSourceIdentity;
      expect(sourceIdentity).toEqual(expect.any(String));

      await harness.cron.run(harness.job.id, "force", {
        evaluateTrigger: true,
        streamBatch: "final batch",
        payload: { kind: "agentTurn", message: "base" },
      });

      const stored = harness.cron.getJob(harness.job.id);
      expect(stored?.enabled).toBe(false);
      expect(stored?.state.streamSourceIdentity).not.toBe(sourceIdentity);
    } finally {
      harness.cron.stop();
    }
  });

  it("appends the gate message and batch to a main-session system event", async () => {
    const { storePath } = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      log: logger,
      enqueueSystemEvent,
      requestHeartbeat: vi.fn(),
      evaluateCronTrigger: vi.fn(async () => ({
        kind: "evaluated" as const,
        fire: true,
        message: "gate message",
      })),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    await cron.start();
    try {
      const job = await cron.add({
        name: "main stream gate",
        enabled: true,
        schedule: { kind: "stream", command: ["echo"] },
        trigger: { script: "return { fire: true }" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "base" },
      });
      await cron.run(job.id, "force", {
        evaluateTrigger: true,
        streamBatch: "firing batch",
        payload: job.payload,
      });
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        "base\n\ngate message\n\nfiring batch",
        expect.any(Object),
      );
    } finally {
      cron.stop();
    }
  });

  it("passes a batch to a script payload without a condition gate", async () => {
    const { storePath } = await makeStorePath();
    const runScriptJob = vi.fn(async () => ({ status: "ok" as const }));
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runScriptJob,
    });
    await cron.start();
    try {
      const job = await cron.add({
        name: "script stream",
        enabled: true,
        schedule: { kind: "stream", command: ["echo"] },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "script", script: "return {}" },
      });
      await cron.run(job.id, "force", {
        evaluateTrigger: true,
        streamBatch: "script batch",
        payload: job.payload,
      });
      expect(runScriptJob).toHaveBeenCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({ id: job.id }),
          streamBatch: "script batch",
        }),
      );
    } finally {
      cron.stop();
    }
  });

  it("does not schedule a context-free timer retry after a manual payload error", async () => {
    const harness = await createHarness(true);
    harness.runIsolatedAgentJob.mockResolvedValueOnce({ status: "error", error: "boom" });
    try {
      await harness.cron.run(harness.job.id, "force", {
        evaluateTrigger: true,
        payload: { kind: "agentTurn", message: "base" },
      });
      expect(harness.cron.getJob(harness.job.id)?.state.nextRunAtMs).toBeUndefined();
    } finally {
      harness.cron.stop();
    }
  });

  it("reports a failed payload batch without reporting it fired", async () => {
    const { storePath } = await makeStorePath();
    const onTriggerDisposition = vi.fn();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      cronConfig: {
        triggers: { enabled: true },
        failureAlert: { enabled: true, after: 1, cooldownMs: 0 },
      },
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "error" as const, error: "boom" })),
      sendCronFailureAlert,
    });
    await cron.start();
    try {
      const job = await cron.add({
        name: "failing stream payload",
        enabled: true,
        schedule: { kind: "stream", command: ["echo"] },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "batch" },
        delivery: { mode: "announce", channel: "telegram", to: "19098680" },
      });
      if (job.schedule.kind !== "stream") {
        throw new Error("expected stream schedule");
      }

      await cron.run(job.id, "force", {
        payload: job.payload,
        evaluateTrigger: true,
        streamBatch: "failed batch",
        onTriggerDisposition,
      });

      expect(onTriggerDisposition).toHaveBeenCalledOnce();
      expect(onTriggerDisposition).toHaveBeenCalledWith("error");
      expect(onTriggerDisposition).not.toHaveBeenCalledWith("fired");
      expect(cron.getJob(job.id)?.state).toMatchObject({
        lastRunStatus: "error",
        consecutiveErrors: 1,
      });
      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      expect(sendCronFailureAlert).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("boom") }),
      );
    } finally {
      cron.stop();
    }
  });

  it("reports a skipped payload batch as a terminal drop", async () => {
    const { storePath } = await makeStorePath();
    const onTriggerDisposition = vi.fn();
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "skipped" as const,
        error: "runner unavailable",
      })),
    });
    await cron.start();
    try {
      const job = await cron.add({
        name: "skipped stream payload",
        enabled: true,
        schedule: { kind: "stream", command: ["echo"] },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "batch" },
      });
      if (job.schedule.kind !== "stream") {
        throw new Error("expected stream schedule");
      }

      await cron.run(job.id, "force", {
        payload: job.payload,
        evaluateTrigger: true,
        streamBatch: "skipped batch",
        onTriggerDisposition,
      });

      expect(onTriggerDisposition).toHaveBeenCalledWith("dropped");
      expect(cron.getJob(job.id)?.state).toMatchObject({ lastRunStatus: "skipped" });
    } finally {
      cron.stop();
    }
  });
});
