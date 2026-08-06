// Coverage for waiting on completion-required async tool tasks.
import { describe, expect, it } from "vitest";
import {
  completeTaskRunByRunId,
  createRunningTaskRun,
} from "../../../tasks/detached-task-runtime.js";
import type { TaskRecord } from "../../../tasks/runtime-internal.js";
import { resetTaskRegistryForTests } from "../../../tasks/task-runtime.test-helpers.js";
import {
  requiresCompletionRequiredAsyncTaskWait,
  shouldWaitForCompletionRequiredAsyncTasks,
  waitForCompletionRequiredAsyncTasks,
  type AsyncStartedToolMeta,
} from "./attempt.async-tasks.js";

function requireCreatedTask(task: TaskRecord | null): TaskRecord {
  // Task registry creation returns null for invalid task shapes; tests require
  // a concrete active record before waiting.
  if (!task) {
    throw new Error("expected test task to be created");
  }
  return task;
}

describe("waitForCompletionRequiredAsyncTasks", () => {
  it("waits for async task ids discovered during the attempt", async () => {
    // Tool metadata is the primary source for async task ids produced during
    // the current attempt.
    resetTaskRegistryForTests();
    const task = requireCreatedTask(
      createRunningTaskRun({
        runtime: "cli",
        taskKind: "image_generation",
        sourceId: "image_generate:openai",
        requesterSessionKey: "agent:main:cron:daily-media:run:run-123",
        ownerKey: "agent:main:cron:daily-media:run:run-123",
        scopeKind: "session",
        runId: "tool:image_generate:run-123",
        task: "daily image",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        startedAt: 1,
        lastEventAt: 1,
      }),
    );
    const metas: AsyncStartedToolMeta[] = [
      {
        toolName: "image_generate",
        asyncStarted: true,
        asyncTaskRunId: "tool:image_generate:run-123",
        asyncTaskId: task.taskId,
      },
    ];

    const waitPromise = waitForCompletionRequiredAsyncTasks({
      getToolMetas: () => metas,
      deadlineAtMs: Date.now() + 10_000,
      pollIntervalMs: 1,
    });
    completeTaskRunByRunId({
      runId: "tool:image_generate:run-123",
      runtime: "cli",
      sessionKey: "agent:main:cron:daily-media:run:run-123",
      endedAt: Date.now(),
      lastEventAt: Date.now(),
      progressSummary: "Generated 1 image",
      terminalSummary: "Generated 1 image.",
    });

    await expect(waitPromise).resolves.toMatchObject({
      waitedRunIds: ["tool:image_generate:run-123"],
      timedOutRunIds: [],
    });
  });

  it("requires a wait when the cron run has an active tracked media task", () => {
    resetTaskRegistryForTests();
    const sessionKey = "agent:main:cron:daily-media:run:run-123";
    createRunningTaskRun({
      runtime: "cli",
      taskKind: "image_generation",
      sourceId: "image_generate:openai",
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      scopeKind: "session",
      runId: "tool:image_generate:run-123",
      task: "daily image",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      startedAt: 1,
      lastEventAt: 1,
    });

    expect(
      requiresCompletionRequiredAsyncTaskWait({
        sessionKey,
        toolMetas: [],
      }),
    ).toBe(true);
  });

  it("skips media task waiting after sessions_yield pauses the attempt", () => {
    resetTaskRegistryForTests();
    const sessionKey = "agent:main:cron:daily-media:run:run-123";
    createRunningTaskRun({
      runtime: "cli",
      taskKind: "image_generation",
      sourceId: "image_generate:openai",
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      scopeKind: "session",
      runId: "tool:image_generate:run-123",
      task: "daily image",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      startedAt: 1,
      lastEventAt: 1,
    });

    expect(
      shouldWaitForCompletionRequiredAsyncTasks({
        sessionKey,
        toolMetas: [
          {
            toolName: "image_generate",
            asyncStarted: true,
            asyncTaskRunId: "tool:image_generate:run-123",
          },
        ],
        yieldDetected: true,
      }),
    ).toBe(false);
    expect(
      shouldWaitForCompletionRequiredAsyncTasks({
        sessionKey,
        toolMetas: [],
        yieldDetected: false,
      }),
    ).toBe(true);
  });

  it("waits for active cron media tasks from the task registry", async () => {
    // Cron media tools may start tasks before metadata is flushed, so the
    // registry is also consulted by session key.
    resetTaskRegistryForTests();
    const sessionKey = "agent:main:cron:daily-media:run:run-123";
    createRunningTaskRun({
      runtime: "cli",
      taskKind: "image_generation",
      sourceId: "image_generate:openai",
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      scopeKind: "session",
      runId: "tool:image_generate:run-123",
      task: "daily image",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      startedAt: 1,
      lastEventAt: 1,
    });

    const waitPromise = waitForCompletionRequiredAsyncTasks({
      getToolMetas: () => [],
      sessionKey,
      deadlineAtMs: Date.now() + 10_000,
      pollIntervalMs: 1,
    });
    completeTaskRunByRunId({
      runId: "tool:image_generate:run-123",
      runtime: "cli",
      sessionKey,
      endedAt: Date.now(),
      lastEventAt: Date.now(),
      progressSummary: "Generated 1 image",
      terminalSummary: "Generated 1 image.",
    });

    await expect(waitPromise).resolves.toMatchObject({
      waitedRunIds: ["tool:image_generate:run-123"],
      timedOutRunIds: [],
    });
  });

  it("waits for active cron video tasks from the task registry", async () => {
    resetTaskRegistryForTests();
    const sessionKey = "agent:main:cron:daily-media:run:run-123";
    createRunningTaskRun({
      runtime: "cli",
      taskKind: "video_generation",
      sourceId: "video_generate:fal",
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      scopeKind: "session",
      runId: "tool:video_generate:run-123",
      task: "daily video",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      startedAt: 1,
      lastEventAt: 1,
    });

    const waitPromise = waitForCompletionRequiredAsyncTasks({
      getToolMetas: () => [],
      sessionKey,
      deadlineAtMs: Date.now() + 10_000,
      pollIntervalMs: 1,
    });
    completeTaskRunByRunId({
      runId: "tool:video_generate:run-123",
      runtime: "cli",
      sessionKey,
      endedAt: Date.now(),
      lastEventAt: Date.now(),
      progressSummary: "Generated 1 video",
      terminalSummary: "Generated 1 video.",
    });

    await expect(waitPromise).resolves.toMatchObject({
      waitedRunIds: ["tool:video_generate:run-123"],
      timedOutRunIds: [],
    });
  });

  it("waits for async task ids discovered after an earlier async completion", async () => {
    resetTaskRegistryForTests();
    const sessionKey = "agent:main:cron:daily-media:run:run-123";
    const imageTask = requireCreatedTask(
      createRunningTaskRun({
        runtime: "cli",
        taskKind: "image_generation",
        sourceId: "image_generate:openai",
        requesterSessionKey: sessionKey,
        ownerKey: sessionKey,
        scopeKind: "session",
        runId: "tool:image_generate:run-123",
        task: "daily image",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        startedAt: 1,
        lastEventAt: 1,
      }),
    );
    const metas: AsyncStartedToolMeta[] = [
      {
        toolName: "image_generate",
        asyncStarted: true,
        asyncTaskRunId: "tool:image_generate:run-123",
        asyncTaskId: imageTask.taskId,
      },
    ];
    let now = 1;
    let pollCount = 0;

    await expect(
      waitForCompletionRequiredAsyncTasks({
        getToolMetas: () => metas,
        deadlineAtMs: 20,
        now: () => now,
        sleep: async (ms) => {
          pollCount += 1;
          now += ms;
          if (pollCount === 1) {
            completeTaskRunByRunId({
              runId: "tool:image_generate:run-123",
              runtime: "cli",
              sessionKey,
              endedAt: now,
              lastEventAt: now,
              progressSummary: "Generated 1 image",
              terminalSummary: "Generated 1 image.",
            });
            const musicTask = requireCreatedTask(
              createRunningTaskRun({
                runtime: "cli",
                taskKind: "music_generation",
                sourceId: "music_generate:fal",
                requesterSessionKey: sessionKey,
                ownerKey: sessionKey,
                scopeKind: "session",
                runId: "tool:music_generate:run-456",
                task: "daily track",
                deliveryStatus: "not_applicable",
                notifyPolicy: "silent",
                startedAt: now,
                lastEventAt: now,
              }),
            );
            metas.push({
              toolName: "music_generate",
              asyncStarted: true,
              asyncTaskRunId: "tool:music_generate:run-456",
              asyncTaskId: musicTask.taskId,
            });
          } else if (pollCount === 2) {
            completeTaskRunByRunId({
              runId: "tool:music_generate:run-456",
              runtime: "cli",
              sessionKey,
              endedAt: now,
              lastEventAt: now,
              progressSummary: "Generated music",
              terminalSummary: "Generated music.",
            });
          }
        },
        pollIntervalMs: 2,
      }),
    ).resolves.toMatchObject({
      waitedRunIds: ["tool:image_generate:run-123", "tool:music_generate:run-456"],
      timedOutRunIds: [],
    });
  });

  it("reports tasks that do not finish before the deadline", async () => {
    resetTaskRegistryForTests();
    createRunningTaskRun({
      runtime: "cli",
      taskKind: "music_generation",
      sourceId: "music_generate:test",
      requesterSessionKey: "agent:main:cron:daily-media:run:run-123",
      ownerKey: "agent:main:cron:daily-media:run:run-123",
      scopeKind: "session",
      runId: "tool:music_generate:run-123",
      task: "daily track",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      startedAt: 1,
      lastEventAt: 1,
    });
    let now = 1;

    await expect(
      waitForCompletionRequiredAsyncTasks({
        getToolMetas: () => [
          {
            toolName: "music_generate",
            asyncStarted: true,
            asyncTaskRunId: "tool:music_generate:run-123",
          },
        ],
        deadlineAtMs: 5,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        pollIntervalMs: 2,
      }),
    ).resolves.toMatchObject({
      waitedRunIds: ["tool:music_generate:run-123"],
      timedOutRunIds: ["tool:music_generate:run-123"],
    });
  });

  it("stops waiting when the run abort signal fires", async () => {
    resetTaskRegistryForTests();
    const sessionKey = "agent:main:cron:daily-media:run:run-123";
    createRunningTaskRun({
      runtime: "cli",
      taskKind: "music_generation",
      sourceId: "music_generate:test",
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      scopeKind: "session",
      runId: "tool:music_generate:run-123",
      task: "daily track",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      startedAt: 1,
      lastEventAt: 1,
    });
    const controller = new AbortController();

    await expect(
      waitForCompletionRequiredAsyncTasks({
        getToolMetas: () => [],
        sessionKey,
        deadlineAtMs: Date.now() + 10_000,
        abortSignal: controller.signal,
        sleep: async () => {
          controller.abort();
        },
        pollIntervalMs: 2,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
