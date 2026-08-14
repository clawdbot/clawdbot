import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { inspectActiveCronRunReceipt } from "./store/run-receipt-store.js";
import type { CronJobCreate } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-detached-media-failure-",
});

function detachedMediaJob(id: string, name = "detached media owner"): CronJobCreate {
  return {
    id,
    name,
    enabled: true,
    schedule: { kind: "every", everyMs: 3_600_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "generate a track" },
  };
}

async function runAndCaptureReceipt(params: {
  cron: CronService;
  storePath: string;
  jobId: string;
  runDone: ReturnType<typeof createDeferred<{ status: "ok"; summary: string }>>;
}) {
  const runPromise = params.cron.run(params.jobId, "force");
  let receipt = inspectActiveCronRunReceipt({
    storePath: params.storePath,
    jobId: params.jobId,
  });
  await vi.waitFor(() => {
    receipt = inspectActiveCronRunReceipt({
      storePath: params.storePath,
      jobId: params.jobId,
    });
    expect(receipt).toBeDefined();
  });
  params.runDone.resolve({ status: "ok", summary: "generation started" });
  await expect(runPromise).resolves.toMatchObject({ ok: true });
  if (!receipt) {
    throw new Error("expected active cron run receipt");
  }
  return receipt;
}

describe("detached media cron failure ownership", () => {
  it("reclassifies the exact originating run after detached generation fails", async () => {
    const { storePath } = await makeStorePath();
    const runDone = createDeferred<{ status: "ok"; summary: string }>();
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => await runDone.promise),
    });
    await cron.start();
    try {
      const job = await cron.add(detachedMediaJob("detached-media-owner"));
      const receipt = await runAndCaptureReceipt({ cron, storePath, jobId: job.id, runDone });
      expect(cron.getJob(job.id)?.state).toMatchObject({
        lastRunAtMs: receipt.startedAtMs,
        lastRunStatus: "ok",
      });

      await expect(
        cron.recordDetachedMediaFailure({
          cronRunReceipt: receipt,
          cronTaskRunId: "cron-task-run-1",
          requesterSessionKey:
            "agent:main:cron:detached-media-owner:run:550e8400-e29b-41d4-a716-446655440000",
          taskId: "media-task-1",
          runId: "tool:music_generate:1",
          toolName: "music_generate",
          error: "Detached music_generate failed: provider exhausted",
        }),
      ).resolves.toBe(true);

      expect(cron.getJob(job.id)?.state).toMatchObject({
        lastRunAtMs: receipt.startedAtMs,
        lastRunStatus: "error",
        lastError: "Detached music_generate failed: provider exhausted",
        consecutiveErrors: 1,
      });
    } finally {
      cron.stop();
    }
  });

  it("ignores a late failure after the originating job is deleted and recreated", async () => {
    const { storePath } = await makeStorePath();
    const runDone = createDeferred<{ status: "ok"; summary: string }>();
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => await runDone.promise),
    });
    await cron.start();
    try {
      const original = await cron.add(detachedMediaJob("replace-detached-media-owner"));
      const receipt = await runAndCaptureReceipt({
        cron,
        storePath,
        jobId: original.id,
        runDone,
      });
      await cron.remove(original.id);
      const replacement = await cron.add(
        detachedMediaJob(original.id, "replacement detached media owner"),
      );

      await expect(
        cron.recordDetachedMediaFailure({
          cronRunReceipt: receipt,
          requesterSessionKey:
            "agent:main:cron:replace-detached-media-owner:run:550e8400-e29b-41d4-a716-446655440001",
          taskId: "media-task-stale",
          runId: "tool:music_generate:stale",
          toolName: "music_generate",
          error: "Detached music_generate failed: stale provider failure",
        }),
      ).resolves.toBe(false);
      expect(cron.getJob(replacement.id)?.state.lastRunStatus).toBeUndefined();
      expect(cron.getJob(replacement.id)?.state.lastError).toBeUndefined();
    } finally {
      cron.stop();
    }
  });

  it("keeps a fast detached failure when it arrives before the parent run finalizes", async () => {
    const { storePath } = await makeStorePath();
    const runDone = createDeferred<{ status: "ok"; summary: string }>();
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => await runDone.promise),
    });
    await cron.start();
    try {
      const job = await cron.add(detachedMediaJob("fast-detached-media-failure"));
      const runPromise = cron.run(job.id, "force");
      let receipt = inspectActiveCronRunReceipt({ storePath, jobId: job.id });
      await vi.waitFor(() => {
        receipt = inspectActiveCronRunReceipt({ storePath, jobId: job.id });
        expect(receipt).toBeDefined();
      });
      if (!receipt) {
        throw new Error("expected active cron run receipt");
      }

      await expect(
        cron.recordDetachedMediaFailure({
          cronRunReceipt: receipt,
          requesterSessionKey:
            "agent:main:cron:fast-detached-media-failure:run:550e8400-e29b-41d4-a716-446655440002",
          taskId: "media-task-fast",
          runId: "tool:music_generate:fast",
          toolName: "music_generate",
          error: "Detached music_generate failed: immediate provider failure",
        }),
      ).resolves.toBe(true);
      runDone.resolve({ status: "ok", summary: "generation started" });
      await runPromise;

      expect(cron.getJob(job.id)?.state).toMatchObject({
        lastRunAtMs: receipt.startedAtMs,
        lastRunStatus: "error",
        lastError: "Detached music_generate failed: immediate provider failure",
      });
    } finally {
      runDone.resolve({ status: "ok", summary: "generation started" });
      cron.stop();
    }
  });

  it("records only the first detached failure for one cron receipt", async () => {
    const { storePath } = await makeStorePath();
    const runDone = createDeferred<{ status: "ok"; summary: string }>();
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => await runDone.promise),
    });
    await cron.start();
    try {
      const job = await cron.add(detachedMediaJob("duplicate-detached-media-failure"));
      const runPromise = cron.run(job.id, "force");
      let receipt = inspectActiveCronRunReceipt({ storePath, jobId: job.id });
      await vi.waitFor(() => {
        receipt = inspectActiveCronRunReceipt({ storePath, jobId: job.id });
        expect(receipt).toBeDefined();
      });
      if (!receipt) {
        throw new Error("expected active cron run receipt");
      }

      const request = {
        cronRunReceipt: receipt,
        requesterSessionKey:
          "agent:main:cron:duplicate-detached-media-failure:run:550e8400-e29b-41d4-a716-446655440003",
        taskId: "media-task-first",
        runId: "tool:music_generate:first",
        toolName: "music_generate",
        error: "Detached music_generate failed: first provider failure",
      };
      await expect(cron.recordDetachedMediaFailure(request)).resolves.toBe(true);
      await expect(
        cron.recordDetachedMediaFailure({
          ...request,
          taskId: "media-task-second",
          runId: "tool:music_generate:second",
          error: "Detached music_generate failed: second provider failure",
        }),
      ).resolves.toBe(false);

      expect(cron.getJob(job.id)?.state).toMatchObject({
        lastRunAtMs: receipt.startedAtMs,
        lastRunStatus: "error",
        lastError: "Detached music_generate failed: first provider failure",
        consecutiveErrors: 1,
      });

      runDone.resolve({ status: "ok", summary: "generation started" });
      await runPromise;
      expect(cron.getJob(job.id)?.state).toMatchObject({
        lastRunStatus: "error",
        lastError: "Detached music_generate failed: first provider failure",
        consecutiveErrors: 1,
      });
    } finally {
      runDone.resolve({ status: "ok", summary: "generation started" });
      cron.stop();
    }
  });
});
