// Background media generation tests cover detached task completion, requester
// wake delivery, and direct media fallback behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resetGeneratedMediaTaskActivityForTests } from "../../tasks/task-runtime.test-helpers.js";
import { hasPendingGeneratedMediaTaskForSessionKey } from "../../tasks/task-status-access.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";

const subagentAnnounceDeliveryMocks = vi.hoisted(() => ({
  deliverSubagentAnnouncement: vi.fn(),
  loadRequesterSessionEntry: vi.fn<() => { entry: Partial<SessionEntry> | undefined }>(() => ({
    entry: undefined,
  })),
}));
const detachedTaskRuntimeMocks = vi.hoisted(() => ({
  completeTaskRunByRunId: vi.fn(),
  createRunningTaskRun: vi.fn(() => ({ taskId: "task-pinned-route" })),
  failTaskRunByRunId: vi.fn(),
  recordTaskRunProgressByRunId: vi.fn(),
}));

const requesterEntry = (context: DeliveryContext): Partial<SessionEntry> => ({
  delivery: normalizeSessionDeliveryState({ context }),
});
const taskRegistryDeliveryRuntimeMocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));
const cronContinuationCleanupMocks = vi.hoisted(() => ({
  removeCronRunContinuationSessionIfIdle: vi.fn(async () => {}),
}));
const sessionMocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn<() => SessionEntry | undefined>(() => undefined),
}));

vi.mock("../subagent-announce-delivery.js", () => subagentAnnounceDeliveryMocks);
vi.mock("../../config/sessions/session-accessor.js", async () => ({
  ...(await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
    "../../config/sessions/session-accessor.js",
  )),
  loadSessionEntry: sessionMocks.loadSessionEntry,
  loadSessionEntryReadOnly: sessionMocks.loadSessionEntry,
}));
vi.mock("../../tasks/detached-task-runtime.js", () => detachedTaskRuntimeMocks);
vi.mock("../../tasks/task-registry-delivery-runtime.js", () => taskRegistryDeliveryRuntimeMocks);
vi.mock("../../tasks/cron-run-continuation-cleanup.js", () => cronContinuationCleanupMocks);

import {
  createMediaGenerationTaskLifecycle,
  scheduleMediaGenerationTaskCompletion,
  shouldDetachMediaGenerationTask,
} from "./media-generate-background-shared.js";

beforeEach(() => {
  resetGeneratedMediaTaskActivityForTests();
  subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockReset();
  subagentAnnounceDeliveryMocks.loadRequesterSessionEntry.mockReset();
  subagentAnnounceDeliveryMocks.loadRequesterSessionEntry.mockReturnValue({ entry: undefined });
  detachedTaskRuntimeMocks.createRunningTaskRun.mockClear();
  detachedTaskRuntimeMocks.completeTaskRunByRunId.mockClear();
  detachedTaskRuntimeMocks.failTaskRunByRunId.mockClear();
  detachedTaskRuntimeMocks.recordTaskRunProgressByRunId.mockClear();
  taskRegistryDeliveryRuntimeMocks.sendMessage.mockReset();
  cronContinuationCleanupMocks.removeCronRunContinuationSessionIfIdle.mockClear();
  sessionMocks.loadSessionEntry.mockReset().mockReturnValue(undefined);
});

function createImageMediaLifecycle() {
  return createMediaGenerationTaskLifecycle({
    toolName: "image_generate",
    taskKind: "image_generation",
    label: "Image generation",
    queuedProgressSummary: "Queued image generation",
    generatedLabel: "image",
    failureProgressSummary: "Image generation failed",
    eventSource: "image_generation",
    announceType: "image generation task",
    completionLabel: "image",
  });
}

describe("shouldDetachMediaGenerationTask", () => {
  it("detaches session-backed media generation", () => {
    expect(shouldDetachMediaGenerationTask("agent:main:discord:direct:123")).toBe(true);
    expect(shouldDetachMediaGenerationTask("agent:main:cron:daily-media")).toBe(true);
    expect(shouldDetachMediaGenerationTask("agent:main:cron:daily-media:run:run-123")).toBe(false);
    expect(shouldDetachMediaGenerationTask(undefined)).toBe(false);
  });

  it("keeps exact cron media inline until a CLI resume binding is durable", () => {
    const sessionKey = "agent:main:cron:daily-media:run:run-123";
    sessionMocks.loadSessionEntry.mockReturnValue({
      sessionId: "run-123",
      updatedAt: 1,
      cronRunContinuation: {
        lifecycleRevision: "revision-1",
        phase: "running",
        cliExecutionProvider: "google-gemini-cli",
      },
    });
    expect(shouldDetachMediaGenerationTask(sessionKey)).toBe(false);

    sessionMocks.loadSessionEntry.mockReturnValue({
      sessionId: "run-123",
      updatedAt: 2,
      cliSessionBindings: {
        "google-gemini-cli": { sessionId: "native-gemini-session" },
      },
      cronRunContinuation: {
        lifecycleRevision: "revision-1",
        phase: "running",
        cliExecutionProvider: "google-gemini-cli",
      },
    });
    expect(shouldDetachMediaGenerationTask(sessionKey)).toBe(true);
  });
});

describe("scheduleMediaGenerationTaskCompletion", () => {
  it("keeps a pending generated-media run fresh until scheduled work settles", async () => {
    vi.useFakeTimers();
    try {
      const scheduled: Array<() => Promise<void>> = [];
      let resolveRun:
        | ((value: {
            provider: string;
            model: string;
            count: number;
            paths: string[];
            wakeResult: string;
          }) => void)
        | undefined;
      const runPromise = new Promise<{
        provider: string;
        model: string;
        count: number;
        paths: string[];
        wakeResult: string;
      }>((resolve) => {
        resolveRun = resolve;
      });
      const lifecycle = {
        createTaskRun: vi.fn(),
        recordTaskProgress: vi.fn(),
        completeTaskRun: vi.fn(),
        failTaskRun: vi.fn(),
        wakeTaskCompletion: vi.fn(async () => ({ status: "delivered" as const })),
      };

      scheduleMediaGenerationTaskCompletion({
        lifecycle,
        handle: {
          taskId: "task-image-123",
          runId: "tool:image_generate:123",
          requesterSessionKey: "agent:main:discord:channel:123",
          taskLabel: "proof image",
        },
        scheduleBackgroundWork: (work) => {
          scheduled.push(work);
        },
        progressSummary: "Generating image",
        toolName: "Image generation",
        onWakeFailure: vi.fn(),
        run: () => runPromise,
      });

      const task = scheduled[0]?.();
      if (!task) {
        throw new Error("expected scheduled media work");
      }
      await vi.advanceTimersByTimeAsync(60_000);
      expect(detachedTaskRuntimeMocks.recordTaskRunProgressByRunId).toHaveBeenCalledWith({
        runId: "tool:image_generate:123",
        runtime: "cli",
        sessionKey: "agent:main:discord:channel:123",
        lastEventAt: expect.any(Number),
        progressSummary: "Generating image",
        eventSummary: undefined,
      });

      resolveRun?.({
        provider: "openai",
        model: "gpt-image-1",
        count: 1,
        paths: ["/tmp/proof.png"],
        wakeResult: "generated",
      });
      await task;
      const callsAfterCompletion =
        detachedTaskRuntimeMocks.recordTaskRunProgressByRunId.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(detachedTaskRuntimeMocks.recordTaskRunProgressByRunId).toHaveBeenCalledTimes(
        callsAfterCompletion,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a generated media task active until completion delivery finishes", async () => {
    // Mark completion only after the requester wake has been attempted; otherwise
    // task status can say done before the visible media reaches the requester.
    const order: string[] = [];
    const scheduled: Array<() => Promise<void>> = [];
    const completeTaskRun = vi.fn(() => {
      order.push("complete");
    });
    const lifecycle = {
      createTaskRun: vi.fn(),
      recordTaskProgress: vi.fn(() => {
        order.push("progress");
      }),
      completeTaskRun,
      failTaskRun: vi.fn(),
      wakeTaskCompletion: vi.fn(async () => {
        order.push("wake");
        expect(completeTaskRun).not.toHaveBeenCalled();
        return { status: "delivered" as const };
      }),
    };

    scheduleMediaGenerationTaskCompletion({
      lifecycle,
      handle: {
        taskId: "task-image-123",
        runId: "tool:image_generate:123",
        requesterSessionKey: "agent:main:discord:channel:123",
        taskLabel: "proof image",
      },
      scheduleBackgroundWork: (work) => {
        scheduled.push(work);
      },
      progressSummary: "Generating image",
      toolName: "Image generation",
      onWakeFailure: vi.fn(),
      run: async () => {
        order.push("run");
        return {
          provider: "openai",
          model: "gpt-image-1",
          count: 1,
          paths: ["/tmp/proof.png"],
          wakeResult: "generated",
        };
      },
    });

    expect(scheduled).toHaveLength(1);
    await scheduled[0]?.();

    expect(order).toEqual(["run", "progress", "wake", "complete"]);
    expect(lifecycle.recordTaskProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        progressSummary: "Generated media; delivering completion",
      }),
    );
    expect(lifecycle.completeTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 1,
        paths: ["/tmp/proof.png"],
        terminalResult: undefined,
      }),
    );
  });

  it("cleans a one-shot exact cron continuation after detached media settles", async () => {
    const sessionKey = "agent:main:cron:one-shot:run:run-123";
    const scheduled: Array<() => Promise<void>> = [];
    subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValueOnce({
      delivered: true,
      path: "direct",
    });
    const lifecycle = createImageMediaLifecycle();
    const handle = lifecycle.createTaskRun({ sessionKey, prompt: "proof image" });

    scheduleMediaGenerationTaskCompletion({
      lifecycle,
      handle,
      scheduleBackgroundWork: (work) => {
        scheduled.push(work);
      },
      progressSummary: "Generating image",
      toolName: "Image generation",
      onWakeFailure: vi.fn(),
      run: async () => ({
        provider: "openai",
        model: "gpt-image-1",
        count: 1,
        paths: ["/tmp/proof.png"],
        wakeResult: "generated",
      }),
    });

    await scheduled[0]?.();

    expect(detachedTaskRuntimeMocks.completeTaskRunByRunId).toHaveBeenCalledOnce();
    expect(
      cronContinuationCleanupMocks.removeCronRunContinuationSessionIfIdle,
    ).toHaveBeenCalledWith(sessionKey);
  });

  it("records a blocked stale cron completion without raw media fallback", async () => {
    const sessionKey = "agent:main:cron:one-shot:run:run-123";
    const scheduled: Array<() => Promise<void>> = [];
    subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValueOnce({
      delivered: false,
      path: "direct",
      reason: "completion_handoff_unavailable",
      error: "cron run continuation owner was lost during gateway restart",
    });
    const lifecycle = createImageMediaLifecycle();
    const handle = lifecycle.createTaskRun({
      sessionKey,
      requesterOrigin: { channel: "discord", to: "channel:123" },
      prompt: "proof image",
    });

    scheduleMediaGenerationTaskCompletion({
      lifecycle,
      handle,
      scheduleBackgroundWork: (work) => {
        scheduled.push(work);
      },
      progressSummary: "Generating image",
      toolName: "Image generation",
      onWakeFailure: vi.fn(),
      run: async () => ({
        provider: "openai",
        model: "gpt-image-1",
        count: 1,
        paths: ["/tmp/proof.png"],
        wakeResult: "generated",
        mediaUrls: ["/tmp/proof.png"],
      }),
    });

    await scheduled[0]?.();

    expect(taskRegistryDeliveryRuntimeMocks.sendMessage).not.toHaveBeenCalled();
    expect(detachedTaskRuntimeMocks.completeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalOutcome: "blocked",
      }),
    );
    expect(
      cronContinuationCleanupMocks.removeCronRunContinuationSessionIfIdle,
    ).toHaveBeenCalledWith(sessionKey);
  });

  it("keeps pending cron media active until a handoff retry delivers it", async () => {
    vi.useFakeTimers();
    try {
      const sessionKey = "agent:main:cron:daily-media:run:run-123";
      const scheduled: Array<() => Promise<void>> = [];
      subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement
        .mockResolvedValueOnce({
          delivered: false,
          path: "none",
          reason: "completion_handoff_pending",
          error: "cron run continuation is not ready",
        })
        .mockResolvedValueOnce({ delivered: true, path: "direct" });
      const lifecycle = createImageMediaLifecycle();
      const handle = lifecycle.createTaskRun({
        sessionKey,
        prompt: "proof image",
      });

      scheduleMediaGenerationTaskCompletion({
        lifecycle,
        handle,
        scheduleBackgroundWork: (work) => {
          scheduled.push(work);
        },
        progressSummary: "Generating image",
        toolName: "Image generation",
        onWakeFailure: vi.fn(),
        run: async () => ({
          provider: "openai",
          model: "gpt-image-1",
          count: 1,
          paths: ["/tmp/proof.png"],
          wakeResult: "generated",
        }),
      });

      const backgroundWork = scheduled[0]?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalledTimes(1);
      expect(detachedTaskRuntimeMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
      expect(hasPendingGeneratedMediaTaskForSessionKey(sessionKey)).toBe(true);

      await vi.advanceTimersByTimeAsync(249);
      expect(subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await backgroundWork;

      expect(subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalledTimes(2);
      expect(detachedTaskRuntimeMocks.completeTaskRunByRunId).toHaveBeenCalledTimes(1);
      expect(hasPendingGeneratedMediaTaskForSessionKey(sessionKey)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps exponential pending-handoff retries until delivery succeeds", async () => {
    vi.useFakeTimers();
    try {
      const scheduled: Array<() => Promise<void>> = [];
      const onWakeFailure = vi.fn();
      let wakeAttempt = 0;
      const lifecycle = {
        createTaskRun: vi.fn(),
        recordTaskProgress: vi.fn(),
        completeTaskRun: vi.fn(),
        failTaskRun: vi.fn(),
        wakeTaskCompletion: vi.fn(async () => {
          wakeAttempt += 1;
          return wakeAttempt < 7
            ? { status: "pending" as const }
            : { status: "delivered" as const };
        }),
      };

      scheduleMediaGenerationTaskCompletion({
        lifecycle,
        handle: {
          taskId: "task-image-pending",
          runId: "tool:image_generate:pending",
          requesterSessionKey: "agent:main:discord:channel:123",
          taskLabel: "proof image",
        },
        scheduleBackgroundWork: (work) => {
          scheduled.push(work);
        },
        progressSummary: "Generating image",
        toolName: "Image generation",
        onWakeFailure,
        run: async () => ({
          provider: "openai",
          model: "gpt-image-1",
          count: 1,
          paths: ["/tmp/proof.png"],
          wakeResult: "generated",
        }),
      });

      const backgroundWork = scheduled[0]?.();
      await vi.advanceTimersByTimeAsync(7_749);
      expect(lifecycle.wakeTaskCompletion).toHaveBeenCalledTimes(6);
      expect(lifecycle.completeTaskRun).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await backgroundWork;
      expect(lifecycle.wakeTaskCompletion).toHaveBeenCalledTimes(7);
      expect(lifecycle.recordTaskProgress).toHaveBeenCalledTimes(7);
      expect(lifecycle.completeTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalResult: undefined,
        }),
      );
      expect(onWakeFailure).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops pending handoff retries at the completion deadline", async () => {
    vi.useFakeTimers();
    try {
      const scheduled: Array<() => Promise<void>> = [];
      const onWakeFailure = vi.fn();
      const lifecycle = {
        createTaskRun: vi.fn(),
        recordTaskProgress: vi.fn(),
        completeTaskRun: vi.fn(),
        failTaskRun: vi.fn(),
        wakeTaskCompletion: vi.fn(async () => ({ status: "pending" as const })),
      };
      scheduleMediaGenerationTaskCompletion({
        lifecycle,
        handle: {
          taskId: "task-image-orphaned",
          runId: "tool:image_generate:orphaned",
          requesterSessionKey: "agent:main:cron:job:run:run-id",
          taskLabel: "proof image",
        },
        scheduleBackgroundWork: (work) => scheduled.push(work),
        progressSummary: "Generating image",
        toolName: "Image generation",
        onWakeFailure,
        run: async () => ({
          provider: "openai",
          model: "gpt-image-1",
          count: 1,
          paths: ["/tmp/proof.png"],
          wakeResult: "generated",
        }),
      });

      const backgroundWork = scheduled[0]?.();
      await vi.advanceTimersByTimeAsync(120_000);
      await backgroundWork;

      expect(lifecycle.wakeTaskCompletion.mock.calls.length).toBeLessThan(70);
      expect(lifecycle.completeTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalResult: expect.objectContaining({ terminalOutcome: "blocked" }),
        }),
      );
      expect(onWakeFailure).toHaveBeenCalledWith(
        "Image generation completion wake failed after successful generation",
        expect.objectContaining({ taskId: "task-image-orphaned" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("completes a generated media task when completion delivery cannot be confirmed", async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const onWakeFailure = vi.fn();
    const lifecycle = {
      createTaskRun: vi.fn(),
      recordTaskProgress: vi.fn(),
      completeTaskRun: vi.fn(),
      failTaskRun: vi.fn(),
      wakeTaskCompletion: vi.fn(async () => ({ status: "permanent_failure" as const })),
    };

    scheduleMediaGenerationTaskCompletion({
      lifecycle,
      handle: {
        taskId: "task-image-456",
        runId: "tool:image_generate:456",
        requesterSessionKey: "agent:main:discord:channel:123",
        taskLabel: "proof image",
      },
      scheduleBackgroundWork: (work) => {
        scheduled.push(work);
      },
      progressSummary: "Generating image",
      toolName: "Image generation",
      onWakeFailure,
      run: async () => ({
        provider: "openai",
        model: "gpt-image-1",
        count: 1,
        paths: ["/tmp/proof.png"],
        wakeResult: "generated",
      }),
    });

    await scheduled[0]?.();

    expect(onWakeFailure).toHaveBeenCalledWith(
      "Image generation completion delivery was not confirmed after successful generation",
      expect.objectContaining({
        runId: "tool:image_generate:456",
        taskId: "task-image-456",
      }),
    );
    expect(lifecycle.completeTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 1,
        paths: ["/tmp/proof.png"],
        terminalResult: {
          terminalOutcome: "blocked",
          terminalSummary:
            "Required completion delivery failed before reaching the requester: completion delivery was not confirmed after successful generation.",
        },
      }),
    );
    expect(lifecycle.failTaskRun).not.toHaveBeenCalled();
    expect(lifecycle.wakeTaskCompletion).toHaveBeenCalledTimes(1);
  });

  it("completes a generated media task when completion wake throws", async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const wakeError = new Error("requester wake failed");
    const lifecycle = {
      createTaskRun: vi.fn(),
      recordTaskProgress: vi.fn(),
      completeTaskRun: vi.fn(),
      failTaskRun: vi.fn(),
      wakeTaskCompletion: vi.fn().mockRejectedValueOnce(wakeError),
    };
    const onWakeFailure = vi.fn();

    scheduleMediaGenerationTaskCompletion({
      lifecycle,
      handle: {
        taskId: "task-image-789",
        runId: "tool:image_generate:789",
        requesterSessionKey: "agent:main:discord:channel:123",
        taskLabel: "proof image",
      },
      scheduleBackgroundWork: (work) => {
        scheduled.push(work);
      },
      progressSummary: "Generating image",
      toolName: "Image generation",
      onWakeFailure,
      run: async () => ({
        provider: "openai",
        model: "gpt-image-1",
        count: 1,
        paths: ["/tmp/proof.png"],
        wakeResult: "generated",
      }),
    });

    await scheduled[0]?.();

    expect(onWakeFailure).toHaveBeenCalledWith(
      "Image generation completion wake failed after successful generation",
      expect.objectContaining({
        error: wakeError,
        runId: "tool:image_generate:789",
        taskId: "task-image-789",
      }),
    );
    expect(lifecycle.completeTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 1,
        paths: ["/tmp/proof.png"],
        terminalResult: {
          terminalOutcome: "blocked",
          terminalSummary:
            "Required completion delivery failed before reaching the requester: requester wake failed.",
        },
      }),
    );
    expect(lifecycle.failTaskRun).not.toHaveBeenCalled();
    expect(lifecycle.wakeTaskCompletion).toHaveBeenCalledTimes(1);
  });

  it("records a blocked completion when the agent-loop wake throws", async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const wakeError = new Error("requester wake failed");
    const lifecycle = {
      createTaskRun: vi.fn(),
      recordTaskProgress: vi.fn(),
      completeTaskRun: vi.fn(),
      failTaskRun: vi.fn(),
      wakeTaskCompletion: vi.fn().mockRejectedValueOnce(wakeError),
    };

    scheduleMediaGenerationTaskCompletion({
      lifecycle,
      handle: {
        taskId: "task-image-direct-recovery",
        runId: "tool:image_generate:direct-recovery",
        requesterSessionKey: "agent:main:discord:channel:123",
        requesterOrigin: {
          channel: "discord",
          to: "channel:123",
        },
        taskLabel: "proof image",
      },
      scheduleBackgroundWork: (work) => {
        scheduled.push(work);
      },
      progressSummary: "Generating image",
      toolName: "Image generation",
      onWakeFailure: vi.fn(),
      run: async () => ({
        provider: "openai",
        model: "gpt-image-1",
        count: 1,
        paths: ["/tmp/proof.png"],
        wakeResult: "generated",
        mediaUrls: ["/tmp/proof.png"],
      }),
    });

    await scheduled[0]?.();

    expect(taskRegistryDeliveryRuntimeMocks.sendMessage).not.toHaveBeenCalled();
    expect(lifecycle.completeTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalResult: expect.objectContaining({ terminalOutcome: "blocked" }),
      }),
    );
    expect(lifecycle.failTaskRun).not.toHaveBeenCalled();
  });

  it("still delivers completion when the post-generation progress update throws", async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const progressError = new Error("progress store failed");
    const onWakeFailure = vi.fn();
    const lifecycle = {
      createTaskRun: vi.fn(),
      recordTaskProgress: vi.fn(() => {
        throw progressError;
      }),
      completeTaskRun: vi.fn(),
      failTaskRun: vi.fn(),
      wakeTaskCompletion: vi.fn(async () => ({ status: "delivered" as const })),
    };

    scheduleMediaGenerationTaskCompletion({
      lifecycle,
      handle: {
        taskId: "task-image-progress-error",
        runId: "tool:image_generate:progress-error",
        requesterSessionKey: "agent:main:discord:channel:123",
        taskLabel: "proof image",
      },
      scheduleBackgroundWork: (work) => {
        scheduled.push(work);
      },
      progressSummary: "Generating image",
      toolName: "Image generation",
      onWakeFailure,
      run: async () => ({
        provider: "openai",
        model: "gpt-image-1",
        count: 1,
        paths: ["/tmp/proof.png"],
        wakeResult: "generated",
      }),
    });

    await scheduled[0]?.();

    expect(onWakeFailure).toHaveBeenCalledWith(
      "Image generation completion progress update failed",
      expect.objectContaining({
        error: progressError,
        runId: "tool:image_generate:progress-error",
        taskId: "task-image-progress-error",
      }),
    );
    expect(lifecycle.wakeTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ok",
        result: "generated",
      }),
    );
    expect(lifecycle.completeTaskRun).toHaveBeenCalled();
    expect(lifecycle.failTaskRun).not.toHaveBeenCalled();
  });

  it("fails the media task when generation itself fails", async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const generationError = new Error("provider returned no images");
    let releaseWake: (() => void) | undefined;
    const wakePending = new Promise<void>((resolve) => {
      releaseWake = resolve;
    });
    const lifecycle = {
      createTaskRun: vi.fn(),
      recordTaskProgress: vi.fn(),
      completeTaskRun: vi.fn(),
      failTaskRun: vi.fn(),
      wakeTaskCompletion: vi.fn(async () => {
        await wakePending;
        return { status: "delivered" as const };
      }),
    };

    scheduleMediaGenerationTaskCompletion({
      lifecycle,
      handle: {
        taskId: "task-image-generation-error",
        runId: "tool:image_generate:generation-error",
        requesterSessionKey: "agent:main:discord:channel:123",
        taskLabel: "proof image",
      },
      scheduleBackgroundWork: (work) => {
        scheduled.push(work);
      },
      progressSummary: "Generating image",
      toolName: "Image generation",
      onWakeFailure: vi.fn(),
      run: async () => {
        throw generationError;
      },
    });

    const backgroundWork = scheduled[0]?.();
    await vi.waitFor(() => expect(lifecycle.wakeTaskCompletion).toHaveBeenCalled());
    expect(lifecycle.failTaskRun).not.toHaveBeenCalled();
    releaseWake?.();
    await backgroundWork;

    expect(lifecycle.failTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        error: generationError,
      }),
    );
    expect(lifecycle.wakeTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        result: "provider returned no images",
      }),
    );
    expect(lifecycle.completeTaskRun).not.toHaveBeenCalled();
  });
});

describe("createMediaGenerationTaskLifecycle", () => {
  it("tracks pending media when the detached runtime does not mirror core tasks", () => {
    const sessionKey = "agent:main:cron:daily-media:run:run-123";
    const lifecycle = createImageMediaLifecycle();

    const handle = lifecycle.createTaskRun({
      sessionKey,
      prompt: "proof image",
    });
    expect(handle).not.toBeNull();
    expect(hasPendingGeneratedMediaTaskForSessionKey(sessionKey)).toBe(true);

    lifecycle.failTaskRun({ handle, error: new Error("stopped") });
    expect(hasPendingGeneratedMediaTaskForSessionKey(sessionKey)).toBe(false);
  });

  it("pins a missing requester target from session state when the task starts", async () => {
    subagentAnnounceDeliveryMocks.loadRequesterSessionEntry.mockReturnValue({
      entry: requesterEntry({ channel: "telegram", to: "5866004662", accountId: "bot-1" }),
    });
    subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValueOnce({
      delivered: true,
    });
    const lifecycle = createImageMediaLifecycle();

    const handle = lifecycle.createTaskRun({
      sessionKey: "agent:main:telegram:5866004662",
      requesterOrigin: { channel: "telegram" },
      prompt: "proof image",
    });
    expect(handle?.requesterOrigin).toEqual({
      channel: "telegram",
      to: "5866004662",
      accountId: "bot-1",
    });

    subagentAnnounceDeliveryMocks.loadRequesterSessionEntry.mockReturnValue({
      entry: requesterEntry({ channel: "telegram", to: "other-peer", accountId: "bot-1" }),
    });
    await lifecycle.wakeTaskCompletion({
      handle,
      status: "ok",
      statusLabel: "completed successfully",
      result: "generated",
    });
    expect(subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({
        completionDirectOrigin: {
          channel: "telegram",
          to: "5866004662",
          accountId: "bot-1",
        },
      }),
    );
  });

  it("does not pin a session target from another account", () => {
    subagentAnnounceDeliveryMocks.loadRequesterSessionEntry.mockReturnValue({
      entry: requesterEntry({ channel: "telegram", to: "peer-b", accountId: "bot-b" }),
    });
    const lifecycle = createImageMediaLifecycle();

    const handle = lifecycle.createTaskRun({
      sessionKey: "agent:main:telegram:shared",
      requesterOrigin: { channel: "telegram", accountId: "bot-a" },
      prompt: "proof image",
    });

    expect(handle?.requesterOrigin).toEqual({
      channel: "telegram",
      to: undefined,
      accountId: "bot-a",
    });

    const accountOnlyHandle = lifecycle.createTaskRun({
      sessionKey: "agent:main:telegram:shared",
      requesterOrigin: { accountId: "bot-a" },
      prompt: "account-only proof image",
    });
    expect(accountOnlyHandle?.requesterOrigin).toEqual({
      channel: undefined,
      to: undefined,
      accountId: "bot-a",
    });
  });

  it("does not pin a stored thread from a different requester target", () => {
    subagentAnnounceDeliveryMocks.loadRequesterSessionEntry.mockReturnValue({
      entry: requesterEntry({ channel: "telegram", to: "room-b", threadId: 99 }),
    });
    const lifecycle = createImageMediaLifecycle();

    const handle = lifecycle.createTaskRun({
      sessionKey: "agent:main:telegram:room-a",
      requesterOrigin: { channel: "telegram", to: "room-a" },
      prompt: "proof image",
    });

    expect(handle?.requesterOrigin).toEqual({
      channel: "telegram",
      to: "room-a",
      accountId: undefined,
    });
  });

  it("pins the external session route for an internal requester origin", () => {
    subagentAnnounceDeliveryMocks.loadRequesterSessionEntry.mockReturnValue({
      entry: requesterEntry({ channel: "telegram", to: "room-a", accountId: "bot-1" }),
    });
    const lifecycle = createImageMediaLifecycle();

    const handle = lifecycle.createTaskRun({
      sessionKey: "agent:main:telegram:room-a",
      requesterOrigin: { channel: "webchat" },
      prompt: "proof image",
    });

    expect(handle?.requesterOrigin).toEqual({
      channel: "telegram",
      to: "room-a",
      accountId: "bot-1",
    });
  });

  it("returns the completion wake delivery result", async () => {
    subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValueOnce({
      delivered: true,
    });
    const lifecycle = createImageMediaLifecycle();

    await expect(
      lifecycle.wakeTaskCompletion({
        handle: {
          taskId: "task-image-789",
          runId: "tool:image_generate:789",
          requesterSessionKey: "agent:main:discord:channel:123",
          taskLabel: "proof image",
          requesterOrigin: {
            channel: "discord",
            to: "channel:123",
          },
        },
        status: "ok",
        statusLabel: "completed successfully",
        result: "generated",
      }),
    ).resolves.toEqual({ status: "delivered" });
  });

  it("treats terminal generated-media fallback failure as handled", async () => {
    subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValueOnce({
      delivered: false,
      path: "direct",
      terminal: true,
      error: "generated media direct delivery failed after partial upload",
    });
    const lifecycle = createImageMediaLifecycle();

    await expect(
      lifecycle.wakeTaskCompletion({
        handle: {
          taskId: "task-image-terminal",
          runId: "tool:image_generate:terminal",
          requesterSessionKey: "agent:main:discord:channel:123",
          taskLabel: "proof image",
          requesterOrigin: {
            channel: "discord",
            to: "channel:123",
          },
        },
        status: "ok",
        statusLabel: "completed successfully",
        result: "generated",
      }),
    ).resolves.toEqual({ status: "delivered" });
  });

  it.each(["completion_handoff_unavailable", "generated_media_missing"] as const)(
    "does not bypass the agent loop after %s",
    async (reason) => {
      subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValueOnce({
        delivered: false,
        reason,
        error: "completion agent did not deliver generated media",
      });
      const lifecycle = createImageMediaLifecycle();

      await expect(
        lifecycle.wakeTaskCompletion({
          handle: {
            taskId: "task-image-direct",
            runId: "tool:image_generate:direct",
            requesterSessionKey: "agent:main:discord:channel:123",
            taskLabel: "proof image",
            requesterOrigin: {
              channel: "discord",
              to: "channel:123",
            },
          },
          status: "ok",
          statusLabel: "completed successfully",
          result: "generated",
          mediaUrls: ["/tmp/proof.png"],
        }),
      ).resolves.toEqual({ status: "permanent_failure" });

      expect(taskRegistryDeliveryRuntimeMocks.sendMessage).not.toHaveBeenCalled();
    },
  );

  it("includes MEDIA directives in music completion wake prompts for session-only delivery", async () => {
    subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValueOnce({
      delivered: true,
    });
    const lifecycle = createMediaGenerationTaskLifecycle({
      toolName: "music_generate",
      taskKind: "music_generation",
      label: "Music generation",
      queuedProgressSummary: "Queued music generation",
      generatedLabel: "track",
      failureProgressSummary: "Music generation failed",
      eventSource: "music_generation",
      announceType: "music generation task",
      completionLabel: "music",
    });

    await expect(
      lifecycle.wakeTaskCompletion({
        handle: {
          taskId: "task-music-webchat",
          runId: "tool:music_generate:webchat",
          requesterSessionKey: "agent:main:dashboard:music-session",
          taskLabel: "night-drive synthwave",
          requesterOrigin: {
            channel: "webchat",
            to: "session:dashboard",
          },
        },
        status: "ok",
        statusLabel: "completed successfully",
        result: 'Generated 1 track.\n- path="/tmp/generated-night-drive.mp3"',
        attachments: [
          {
            type: "audio",
            path: "/tmp/generated-night-drive.mp3",
            mimeType: "audio/mpeg",
            name: "generated-night-drive.mp3",
          },
        ],
      }),
    ).resolves.toEqual({ status: "delivered" });

    expect(subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterSessionKey: "agent:main:dashboard:music-session",
        requesterSessionOrigin: {
          channel: "webchat",
          to: "session:dashboard",
        },
        completionDirectOrigin: {
          channel: "webchat",
          to: "session:dashboard",
        },
        sourceTool: "music_generate",
        bestEffortDeliver: true,
        durableGeneratedMediaHandoff: true,
      }),
    );
    const announceParams = subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mock
      .calls[0]?.[0] as { triggerMessage?: string; internalEvents?: unknown[] } | undefined;
    expect(announceParams?.triggerMessage).toContain("MEDIA:/tmp/generated-night-drive.mp3");
    expect(announceParams?.internalEvents).toEqual([
      expect.objectContaining({
        mediaUrls: ["/tmp/generated-night-drive.mp3"],
        attachments: [
          expect.objectContaining({
            path: "/tmp/generated-night-drive.mp3",
          }),
        ],
      }),
    ]);
    expect(taskRegistryDeliveryRuntimeMocks.sendMessage).not.toHaveBeenCalled();
  });

  it("does not direct-deliver generated media after requester abandonment", async () => {
    // Abandoned requester sessions are terminal; direct delivery would re-open a
    // conversation the task lifecycle already decided to stop.
    subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValueOnce({
      delivered: false,
      path: "none",
      reason: "requester_abandoned",
      error: "requester session abandoned after timeout",
    });
    const lifecycle = createImageMediaLifecycle();

    await expect(
      lifecycle.wakeTaskCompletion({
        handle: {
          taskId: "task-image-abandoned",
          runId: "tool:image_generate:abandoned",
          requesterSessionKey: "agent:main:discord:channel:123",
          taskLabel: "proof image",
          requesterOrigin: {
            channel: "discord",
            to: "channel:123",
          },
        },
        status: "ok",
        statusLabel: "completed successfully",
        result: "generated",
        mediaUrls: ["/tmp/proof.png"],
      }),
    ).resolves.toEqual({ status: "permanent_failure" });

    expect(taskRegistryDeliveryRuntimeMocks.sendMessage).not.toHaveBeenCalled();
  });

  it("does not direct-deliver generated media after a generic handoff failure", async () => {
    subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValueOnce({
      delivered: false,
      path: "direct",
      error: "gateway request timeout for agent",
    });
    const lifecycle = createImageMediaLifecycle();

    await expect(
      lifecycle.wakeTaskCompletion({
        handle: {
          taskId: "task-image-timeout",
          runId: "tool:image_generate:timeout",
          requesterSessionKey: "agent:main:discord:channel:123",
          taskLabel: "proof image",
          requesterOrigin: {
            channel: "discord",
            to: "channel:123",
          },
        },
        status: "ok",
        statusLabel: "completed successfully",
        result: "generated",
        mediaUrls: ["/tmp/proof.png"],
      }),
    ).resolves.toEqual({ status: "permanent_failure" });

    expect(taskRegistryDeliveryRuntimeMocks.sendMessage).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
