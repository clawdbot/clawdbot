import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildActiveImageGenerationTaskPromptContextForSession,
  buildImageGenerationTaskStatusDetails,
  buildImageGenerationTaskStatusText,
  findActiveImageGenerationTaskForSession,
  findDuplicateGuardImageGenerationTaskForSession,
  getImageGenerationTaskProviderId,
  isActiveImageGenerationTask,
  IMAGE_GENERATION_TASK_KIND,
} from "./image-generation-task-status.js";
import {
  findRecentStartedMediaGenerationTaskForSession,
  recordRecentMediaGenerationTaskStartForSession,
  resetRecentMediaGenerationDuplicateGuardsForTests,
} from "./media-generation-task-status-shared.js";

const taskRuntimeInternalMocks = vi.hoisted(() => {
  const mocks = {
    listTasksForOwnerKey: vi.fn(),
    listFreshTasksForOwnerKey: vi.fn(),
    reloadTaskRegistryFromStore: vi.fn(),
  };
  mocks.listFreshTasksForOwnerKey.mockImplementation((ownerKey) =>
    mocks.listTasksForOwnerKey(ownerKey),
  );
  return mocks;
});

vi.mock("../tasks/runtime-internal.js", () => taskRuntimeInternalMocks);

function expectActiveImageGenerationTask(
  task: ReturnType<typeof findActiveImageGenerationTaskForSession>,
): NonNullable<ReturnType<typeof findActiveImageGenerationTaskForSession>> {
  if (task == null) {
    throw new Error("Expected active image generation task");
  }
  return task;
}

describe("image generation task status", () => {
  beforeEach(() => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReset();
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([]);
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReset();
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockImplementation((ownerKey) =>
      taskRuntimeInternalMocks.listTasksForOwnerKey(ownerKey),
    );
    taskRuntimeInternalMocks.reloadTaskRegistryFromStore.mockReset();
    resetRecentMediaGenerationDuplicateGuardsForTests();
  });

  it("recognizes active session-backed image generation tasks", () => {
    expect(
      isActiveImageGenerationTask({
        taskId: "task-1",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "make watercolor robot",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
      }),
    ).toBe(true);
    expect(
      isActiveImageGenerationTask({
        taskId: "task-2",
        runtime: "cron",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "make watercolor robot",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
      }),
    ).toBe(false);
  });

  it("prefers a running task over queued session siblings", () => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-queued",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:google",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "queued task",
        status: "queued",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
      },
      {
        taskId: "task-running",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "running task",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
        progressSummary: "Generating image",
      },
    ]);

    const task = findActiveImageGenerationTaskForSession("agent:main");

    expect(task?.taskId).toBe("task-running");
    const activeTask = expectActiveImageGenerationTask(task);
    expect(getImageGenerationTaskProviderId(activeTask)).toBe("openai");
    expect(buildImageGenerationTaskStatusText(activeTask, { duplicateGuard: true })).toContain(
      "Do not call image_generate again for this request.",
    );
    const details = buildImageGenerationTaskStatusDetails(activeTask);
    expect(details.active).toBe(true);
    expect(details.existingTask).toBe(true);
    expect(details.status).toBe("running");
    expect(details.taskKind).toBe(IMAGE_GENERATION_TASK_KIND);
    expect(details.provider).toBe("openai");
    expect(details.progressSummary).toBe("Generating image");
  });

  it("can restrict active lookup to the matching image prompt", () => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-first",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "First diagram prompt",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
      },
      {
        taskId: "task-second",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "Second diagram prompt",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
      },
    ]);

    expect(
      findActiveImageGenerationTaskForSession("agent:main", {
        prompt: "Second diagram prompt",
      })?.taskId,
    ).toBe("task-second");
    expect(
      findActiveImageGenerationTaskForSession("agent:main", {
        prompt: "Third diagram prompt",
      }),
    ).toBeUndefined();
  });

  it("uses a matching recent-start request key as a succeeded duplicate guard", () => {
    const now = Date.now();
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "agent:main",
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourcePrefix: "image_generate",
      taskId: "task-completed",
      runId: "run-completed",
      taskLabel: "recent prompt",
      requestKey: "image-request:a",
      providerId: "xai",
      progressSummary: "Generating image",
      nowMs: now - 20_000,
    });
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-completed",
        runId: "run-completed",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:xai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "recent prompt",
        status: "succeeded",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: now - 20_000,
        endedAt: now - 10_000,
        progressSummary: "Generated 1 image",
      },
    ]);

    const task = findDuplicateGuardImageGenerationTaskForSession("agent:main", {
      requestKey: "image-request:a",
    });

    expect(task?.taskId).toBe("task-completed");
    const statusText = buildImageGenerationTaskStatusText(task!, { duplicateGuard: true });
    expect(statusText).toContain(
      "Image generation task task-completed recently succeeded with xai.",
    );
    expect(statusText).toContain(
      "Do not call image_generate again for the same request; this recent image generation already completed.",
    );
  });

  it("does not use a delivery-blocked image task as a succeeded duplicate guard", () => {
    const now = Date.now();
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "agent:main",
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourcePrefix: "image_generate",
      taskId: "task-blocked-delivery",
      runId: "run-blocked-delivery",
      taskLabel: "recent prompt",
      requestKey: "image-request:blocked",
      providerId: "xai",
      progressSummary: "Generating image",
      nowMs: now - 20_000,
    });
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-blocked-delivery",
        runId: "run-blocked-delivery",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:xai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "recent prompt",
        status: "succeeded",
        terminalOutcome: "blocked",
        terminalSummary: "Required completion delivery failed before reaching the requester.",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: now - 20_000,
        endedAt: now - 10_000,
        progressSummary: "Generated 1 image",
      },
    ]);

    expect(
      findDuplicateGuardImageGenerationTaskForSession("agent:main", {
        requestKey: "image-request:blocked",
      }),
    ).toBeUndefined();
  });

  it("does not use a recent succeeded image task without a matching request key", () => {
    const now = Date.now();
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "agent:main",
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourcePrefix: "image_generate",
      taskId: "task-completed",
      runId: "run-completed",
      taskLabel: "recent prompt",
      requestKey: "image-request:a",
      providerId: "xai",
      progressSummary: "Generating image",
      nowMs: now - 20_000,
    });
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-completed",
        runId: "run-completed",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:xai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "recent prompt",
        status: "succeeded",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: now - 20_000,
        endedAt: now - 10_000,
        progressSummary: "Generated 1 image",
      },
    ]);

    expect(
      findDuplicateGuardImageGenerationTaskForSession("agent:main", {
        requestKey: "image-request:b",
      }),
    ).toBeUndefined();
  });

  it("preserves earlier recent request keys when another image request starts", () => {
    const now = Date.now();
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "agent:main",
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourcePrefix: "image_generate",
      taskId: "task-first",
      runId: "run-first",
      taskLabel: "first prompt",
      requestKey: "image-request:first",
      providerId: "xai",
      progressSummary: "Generating first image",
      nowMs: now - 30_000,
    });
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "agent:main",
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourcePrefix: "image_generate",
      taskId: "task-second",
      runId: "run-second",
      taskLabel: "second prompt",
      requestKey: "image-request:second",
      providerId: "xai",
      progressSummary: "Generating second image",
      nowMs: now - 20_000,
    });
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-first",
        runId: "run-first",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:xai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "first prompt",
        status: "succeeded",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: now - 30_000,
        endedAt: now - 15_000,
        progressSummary: "Generated first image",
      },
      {
        taskId: "task-second",
        runId: "run-second",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:xai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "second prompt",
        status: "succeeded",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: now - 20_000,
        endedAt: now - 10_000,
        progressSummary: "Generated second image",
      },
    ]);

    expect(
      findDuplicateGuardImageGenerationTaskForSession("agent:main", {
        requestKey: "image-request:first",
      })?.taskId,
    ).toBe("task-first");
  });

  it("prunes stale same-session recent starts when another image request starts", () => {
    const now = Date.now();
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "agent:main",
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourcePrefix: "image_generate",
      taskId: "task-stale",
      runId: "run-stale",
      taskLabel: "stale prompt",
      requestKey: "image-request:stale",
      providerId: "xai",
      progressSummary: "Generating stale image",
      nowMs: now - 3 * 60_000,
    });
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "agent:main",
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourcePrefix: "image_generate",
      taskId: "task-fresh",
      runId: "run-fresh",
      taskLabel: "fresh prompt",
      requestKey: "image-request:fresh",
      providerId: "xai",
      progressSummary: "Generating fresh image",
      nowMs: now,
    });

    expect(
      findRecentStartedMediaGenerationTaskForSession({
        sessionKey: "agent:main",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourcePrefix: "image_generate",
        taskLabel: "stale prompt",
        requestKey: "image-request:stale",
        maxAgeMs: 10 * 60_000,
        nowMs: now,
      }),
    ).toBeUndefined();
  });

  it("does not keep stale recent starts forever for non-finite maxAgeMs", () => {
    const now = Date.now();
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "agent:main",
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourcePrefix: "image_generate",
      taskId: "task-stale",
      runId: "run-stale",
      taskLabel: "stale prompt",
      requestKey: "image-request:stale",
      providerId: "xai",
      progressSummary: "Generating stale image",
      nowMs: now - 1,
    });

    expect(
      findRecentStartedMediaGenerationTaskForSession({
        sessionKey: "agent:main",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourcePrefix: "image_generate",
        taskLabel: "stale prompt",
        requestKey: "image-request:stale",
        maxAgeMs: Number.POSITIVE_INFINITY,
        nowMs: now,
      }),
    ).toBeUndefined();
  });

  it("does not block a distinct prompt from a cached active recent start", () => {
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "agent:main",
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourcePrefix: "image_generate",
      taskId: "task-first",
      runId: "run-first",
      taskLabel: "first prompt",
      requestKey: "image-request:first",
      providerId: "xai",
      progressSummary: "Generating first image",
    });

    expect(
      findDuplicateGuardImageGenerationTaskForSession("agent:main", {
        prompt: "second prompt",
      }),
    ).toBeUndefined();
  });

  it("uses a recent persisted completion instead of pruning a stale recent-start cache", () => {
    const now = Date.now();
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "agent:main",
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourcePrefix: "image_generate",
      taskId: "task-completed",
      runId: "run-completed",
      taskLabel: "recent prompt",
      requestKey: "image-request:stale",
      providerId: "xai",
      progressSummary: "Generating image",
      nowMs: now - 3 * 60_000,
    });
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-completed",
        runId: "run-completed",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:xai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "recent prompt",
        status: "succeeded",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: now - 3 * 60_000,
        endedAt: now - 1_000,
        progressSummary: "Generated 1 image",
      },
    ]);

    const task = findDuplicateGuardImageGenerationTaskForSession("agent:main", {
      requestKey: "image-request:stale",
    });

    expect(task?.status).toBe("succeeded");
    expect(buildImageGenerationTaskStatusText(task!, { duplicateGuard: true })).toContain(
      "Image generation task task-completed recently succeeded with xai.",
    );
  });

  it("clears the recent-start cache when the persisted task has failed", () => {
    const now = Date.now();
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "agent:main",
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourcePrefix: "image_generate",
      taskId: "task-failed",
      runId: "run-failed",
      taskLabel: "retryable prompt",
      providerId: "xai",
      progressSummary: "Generating image",
      nowMs: now - 5_000,
    });
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-failed",
        runId: "run-failed",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:xai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "retryable prompt",
        status: "failed",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: now - 5_000,
        endedAt: now - 1_000,
        progressSummary: "Image generation failed",
      },
    ]);

    expect(findDuplicateGuardImageGenerationTaskForSession("agent:main")).toBeUndefined();
  });

  it("builds prompt context for active session work", () => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-running",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "running task",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
        progressSummary: "Generating image",
      },
    ]);

    const context = buildActiveImageGenerationTaskPromptContextForSession("agent:main");

    expect(context).toContain("An active image generation background task already exists");
    expect(context).toContain("Task task-running is currently running via openai.");
    expect(context).toContain('call `image_generate` with `action:"status"`');
  });
});
